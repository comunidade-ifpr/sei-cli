import { readFile } from "node:fs/promises";
import path from "node:path";
import { Command, Help, Option } from "commander";
import { formatarDataHoraParaHumano } from "../dominio/tempo";
import { validarNumeroProcessoSei } from "../dominio/texto";
import { carregarEnvLocal } from "../infra/env";
import { encontrarSnapshotMaisRecenteProcesso } from "../infra/arquivos";
import { lerDiretorioProcesso, lerZipProcesso } from "../infra/local";
import {
  abrirSessaoConsultaHistoricoSei,
  consultarHistoricoProcessoSei,
  extrairProcessoSei,
  localizarLinkProcessoSei,
  type SessaoConsultaHistoricoSei,
} from "../infra/playwrightSei";
import {
  carregarProcessoParaInspecao,
  compararAtualizacaoProcesso,
  formatarEventoHistoricoParaResumo,
  inspecionarUltimaAtualizacao,
  listarUltimosDocumentos,
  listarUltimosEventosHistorico,
  resumirExtracao,
  resumirMovimentacaoProcesso,
} from "../aplicacao/inspecionar";
import type {
  DocumentoProcesso,
  HistoricoProcessoItem,
  ProcessoExtraido,
  ResultadoAtualizacaoProcesso,
  ResultadoExtracao,
  ResultadoLoteExtracaoItem,
  ResultadoLoteMovimentacaoItem,
  ResultadoResumoMovimentacao,
} from "../tipos";

interface OpcoesCli {
  json: boolean;
  jsonl: boolean;
  quiet: boolean;
  resumo: boolean;
  snapshotAuto: boolean;
  atualizar: boolean;
  saida?: string;
  zip?: string;
  diretorio?: string;
  snapshot?: string;
  ultimos?: number;
  formato?: string;
}

const PROCESSO_RE = /\d{5}\.\d{6}\/\d{4}-\d{2}/g;
const PROCESSO_EXATO_RE = /^\d{5}\.\d{6}\/\d{4}-\d{2}$/;
const TIMEOUT_CONSULTA_LOTE_MS = 60_000;

function normalizarOpcoes(opcoes: Partial<OpcoesCli> = {}): OpcoesCli {
  return {
    json: opcoes.json ?? false,
    jsonl: opcoes.jsonl ?? false,
    quiet: opcoes.quiet ?? false,
    resumo: opcoes.resumo ?? false,
    snapshotAuto: opcoes.snapshotAuto ?? false,
    atualizar: opcoes.atualizar ?? false,
    saida: opcoes.saida,
    zip: opcoes.zip,
    diretorio: opcoes.diretorio,
    snapshot: opcoes.snapshot,
    ultimos: opcoes.ultimos,
    formato: opcoes.formato,
  };
}

function lerQuantidade(valor: string) {
  return Number.parseInt(valor, 10);
}

function validarQuantidade(valor: number | undefined, padrao: number) {
  const quantidade = valor ?? padrao;
  if (!Number.isFinite(quantidade) || quantidade <= 0) {
    throw new Error("Informe --ultimos com um número inteiro positivo.");
  }
  return quantidade;
}

function imprimirJson(valor: unknown) {
  console.log(JSON.stringify(valor, null, 2));
}

function imprimirJsonl(valor: unknown) {
  console.log(JSON.stringify(valor));
}

function registrarProgresso(opcoes: OpcoesCli, mensagem: string) {
  if (!opcoes.quiet) {
    console.error(mensagem);
  }
}

async function executarComTimeout<T>(operacao: Promise<T>, timeoutMs: number, mensagem: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operacao,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(mensagem)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function caminhoProcessoJson(snapshot: string) {
  return path.join(snapshot, "processo.json");
}

function formatarExtracaoParaSaida(resultado: ResultadoExtracao, opcoes: OpcoesCli) {
  return opcoes.resumo ? resumirExtracao(resultado) : resultado;
}

function imprimirResumoExtracao(resultado: ResultadoExtracao) {
  console.log(`Processo ${resultado.processo.numero_processo} extraído com sucesso.`);
  console.log(`Origem: ${resultado.processo.origem}`);
  console.log(`Documentos: ${resultado.processo.documentos.length}`);
  console.log(`Histórico: ${resultado.processo.historico.length} evento(s)`);
  console.log(`Pasta: ${resultado.diretorio_execucao}`);
  console.log(`JSON: ${resultado.caminho_processo_json}`);
}

function imprimirResultadoExtracao(resultado: ResultadoExtracao, opcoes: OpcoesCli) {
  if (opcoes.json) {
    imprimirJson(formatarExtracaoParaSaida(resultado, opcoes));
    return;
  }
  imprimirResumoExtracao(resultado);
}

function imprimirDocumento(documento: DocumentoProcesso, indice: number) {
  const numero = documento.numero_sei ? `SEI ${documento.numero_sei}` : "sem número SEI";
  const data = formatarDataHoraParaHumano(documento.modificado_em ?? documento.criado_em);
  console.log(`${indice + 1}. ${documento.titulo} (${numero}, ${documento.tipo_documento}, ${data})`);
  if (documento.caminho_relativo) {
    console.log(`   arquivo: ${documento.caminho_relativo}`);
  }
}

function imprimirEventoHistorico(evento: HistoricoProcessoItem, indice: number) {
  const data = formatarDataHoraParaHumano(evento.ocorrido_em);
  const origem = [evento.unidade, evento.usuario].filter(Boolean).join(" / ");
  console.log(`${indice + 1}. ${data}${origem ? ` - ${origem}` : ""}`);
  console.log(`   ${evento.descricao}`);
}

function imprimirResumoMovimentacao(resultado: ResultadoResumoMovimentacao) {
  console.log(`Processo ${resultado.numero_processo}`);
  if (resultado.snapshot) {
    console.log(`Snapshot: ${resultado.snapshot}`);
  }
  if (resultado.caminho_processo_json) {
    console.log(`JSON: ${resultado.caminho_processo_json}`);
  }
  console.log(`Data de abertura SEI: ${resultado.data_abertura_sei ?? "indisponível"}`);
  console.log(`Data Última mov. SEI: ${resultado.data_ultima_mov_sei ?? "indisponível"}`);
  console.log(`Histórico usado: ${resultado.historico_usado.length} de ${resultado.historico_total} evento(s)`);
  console.log("Última movimentação SEI:");
  console.log(resultado.ultima_movimentacao_sei_texto || "histórico indisponível");
}

function imprimirAtualizacao(resultado: ResultadoAtualizacaoProcesso, opcoes: OpcoesCli) {
  if (opcoes.json) {
    imprimirJson(resultado);
    return;
  }
  console.log(`Processo ${resultado.numero_processo}`);
  console.log(`Atualizado: ${resultado.atualizado ? "sim" : "não"}`);
  console.log(`Extração realizada: ${resultado.extracao_realizada ? "sim" : "não"}`);
  if (resultado.snapshot_usado) {
    console.log(`Snapshot usado: ${resultado.snapshot_usado}`);
  }
  if (resultado.verificacao) {
    console.log(`Motivo: ${resultado.verificacao.motivo}`);
  }
  if (resultado.resumo_movimentacao) {
    console.log("");
    imprimirResumoMovimentacao(resultado.resumo_movimentacao);
  }
}

async function extrairProcesso(numeroProcesso: string, opcoes: OpcoesCli) {
  return extrairProcessoSei({
    numeroProcesso,
    saida: opcoes.saida,
    quiet: opcoes.quiet,
  });
}

async function resolverSnapshotProcesso(numeroProcesso: string, opcoes: OpcoesCli) {
  if (opcoes.snapshot) {
    return path.resolve(opcoes.snapshot);
  }
  if (opcoes.snapshotAuto) {
    return encontrarSnapshotMaisRecenteProcesso(numeroProcesso);
  }
  return undefined;
}

async function carregarProcessoDeSnapshot(snapshot: string) {
  const diretorio = path.resolve(snapshot);
  return {
    diretorio,
    caminhoJson: caminhoProcessoJson(diretorio),
    processo: await carregarProcessoParaInspecao(diretorio),
  };
}

async function resolverSnapshotParaInspecao(valor: string) {
  const valorNormalizado = valor.trim();
  if (!PROCESSO_EXATO_RE.test(valorNormalizado)) {
    return path.resolve(valor);
  }

  const numero = validarNumeroProcessoSei(valorNormalizado);
  const snapshot = await encontrarSnapshotMaisRecenteProcesso(numero);
  if (!snapshot) {
    throw new Error(
      `Nenhum snapshot local encontrado para o processo ${numero}. Informe o runDir ou extraia o processo primeiro.`,
    );
  }
  return snapshot;
}

async function executarAtualizacaoProcesso(numeroProcesso: string, opcoes: OpcoesCli) {
  const numero = validarNumeroProcessoSei(numeroProcesso);
  const quantidade = validarQuantidade(opcoes.ultimos, 4);
  const snapshot = await resolverSnapshotProcesso(numero, opcoes);
  let verificacao: ResultadoAtualizacaoProcesso["verificacao"];

  if (!snapshot && !opcoes.snapshotAuto) {
    throw new Error("Informe --snapshot <runDir> ou --snapshot-auto para atualizar um processo.");
  }

  if (snapshot) {
    const local = await carregarProcessoDeSnapshot(snapshot);
    if (local.processo.numero_processo !== numero) {
      throw new Error(`O snapshot informado é do processo ${local.processo.numero_processo}, não de ${numero}.`);
    }
    const remoto = await consultarHistoricoProcessoSei({ numeroProcesso: numero });
    verificacao = compararAtualizacaoProcesso({
      processoLocal: local.processo,
      historicoRemoto: remoto.historico,
      snapshot: local.diretorio,
    });

    if (verificacao.atualizado) {
      return {
        numero_processo: numero,
        atualizado: true,
        extracao_realizada: false,
        snapshot_usado: local.diretorio,
        verificacao,
        resumo_movimentacao: resumirMovimentacaoProcesso({
          processo: local.processo,
          quantidade,
          snapshot: local.diretorio,
          caminhoProcessoJson: local.caminhoJson,
        }),
      } satisfies ResultadoAtualizacaoProcesso;
    }
  }

  const resultado = await extrairProcesso(numero, opcoes);
  return {
    numero_processo: numero,
    atualizado: true,
    extracao_realizada: true,
    snapshot_usado: resultado.diretorio_execucao,
    verificacao,
    resultado_extracao: formatarExtracaoParaSaida(resultado, opcoes),
    resumo_movimentacao: resumirMovimentacaoProcesso({
      processo: resultado.processo,
      quantidade,
      snapshot: resultado.diretorio_execucao,
      caminhoProcessoJson: resultado.caminho_processo_json,
    }),
  } satisfies ResultadoAtualizacaoProcesso;
}

async function executarResumoMovimentacao(valor: string, opcoes: OpcoesCli) {
  const quantidade = validarQuantidade(opcoes.ultimos, 4);
  const valorNormalizado = valor.trim();
  const numero = PROCESSO_EXATO_RE.test(valorNormalizado)
    ? validarNumeroProcessoSei(valorNormalizado)
    : undefined;

  if (opcoes.snapshot || (!numero && valor)) {
    const snapshot = path.resolve(opcoes.snapshot ?? valor);
    const local = await carregarProcessoDeSnapshot(snapshot);
    if (numero && local.processo.numero_processo !== numero) {
      throw new Error(`O snapshot informado é do processo ${local.processo.numero_processo}, não de ${numero}.`);
    }
    return resumirMovimentacaoProcesso({
      processo: local.processo,
      quantidade,
      snapshot: local.diretorio,
      caminhoProcessoJson: local.caminhoJson,
    });
  }

  if (!numero) {
    throw new Error("Uso esperado: sei resumir movimentacao <numero|runDir> [--snapshot <runDir>] [--json].");
  }

  if (opcoes.atualizar) {
    const atualizacao = await executarAtualizacaoProcesso(numero, {
      ...opcoes,
      snapshotAuto: true,
      resumo: true,
    });
    if (!atualizacao.resumo_movimentacao) {
      throw new Error("Não foi possível gerar resumo de movimentação após atualização.");
    }
    return atualizacao.resumo_movimentacao;
  }

  if (opcoes.snapshotAuto) {
    const snapshot = await encontrarSnapshotMaisRecenteProcesso(numero);
    if (snapshot) {
      const local = await carregarProcessoDeSnapshot(snapshot);
      return resumirMovimentacaoProcesso({
        processo: local.processo,
        quantidade,
        snapshot: local.diretorio,
        caminhoProcessoJson: local.caminhoJson,
      });
    }
  }

  const resultado = await extrairProcesso(numero, opcoes);
  return resumirMovimentacaoProcesso({
    processo: resultado.processo,
    quantidade,
    snapshot: resultado.diretorio_execucao,
    caminhoProcessoJson: resultado.caminho_processo_json,
  });
}

function linkProcessoSei(baseUrl: string | undefined, idProcedimento: string | undefined) {
  if (!baseUrl || !idProcedimento) {
    return undefined;
  }
  return `${baseUrl.replace(/\/$/, "")}/sei/controlador.php?acao=procedimento_trabalhar&id_procedimento=${idProcedimento}`;
}

async function executarUltimasMovimentacoesRemotas(
  numeroProcesso: string,
  opcoes: OpcoesCli,
  sessao?: SessaoConsultaHistoricoSei,
) {
  const numero = validarNumeroProcessoSei(numeroProcesso);
  const quantidade = validarQuantidade(opcoes.ultimos, 4);
  const consultadoEm = new Date().toISOString();
  const remoto = sessao
    ? await executarComTimeout(
        sessao.consultar({ numeroProcesso: numero }),
        TIMEOUT_CONSULTA_LOTE_MS,
        `Consulta de ${numero} excedeu ${TIMEOUT_CONSULTA_LOTE_MS / 1_000} segundos.`,
      )
    : await consultarHistoricoProcessoSei({ numeroProcesso: numero });
  const processo: ProcessoExtraido = {
    versao_schema: 1,
    numero_processo: numero,
    extraido_em: consultadoEm,
    origem: "playwright-sei",
    sei_base_url: remoto.sei_base_url,
    sei_id_procedimento: remoto.sei_id_procedimento,
    sei_link_processo: linkProcessoSei(remoto.sei_base_url, remoto.sei_id_procedimento),
    historico: remoto.historico,
    documentos: [],
    eventos: [],
    artefatos: {
      diretorio_documentos: "",
    },
  };
  const resumo = resumirMovimentacaoProcesso({
    processo,
    quantidade,
    fonteDados: "historico_remoto",
    consultadoRemotamenteEm: consultadoEm,
  });
  if (!resumo.data_ultima_mov_sei) {
    throw new Error(`Histórico remoto de ${numero} não retornou Data Última mov. SEI.`);
  }
  return resumo;
}

function extrairNumerosProcessos(conteudo: string) {
  const vistos = new Set<string>();
  const numeros: string[] = [];
  for (const correspondencia of conteudo.matchAll(PROCESSO_RE)) {
    const numero = validarNumeroProcessoSei(correspondencia[0]);
    if (!vistos.has(numero)) {
      vistos.add(numero);
      numeros.push(numero);
    }
  }
  return numeros;
}

async function executarLoteExtracao(arquivo: string, opcoes: OpcoesCli) {
  const caminho = path.resolve(arquivo);
  const numeros = extrairNumerosProcessos(await readFile(caminho, "utf-8"));
  if (!numeros.length) {
    throw new Error(`Nenhum número de processo SEI encontrado em ${caminho}.`);
  }
  if (opcoes.saida) {
    throw new Error("Não use --saida com extração em lote; a saída padrão já separa snapshots por processo.");
  }

  const resultados: ResultadoLoteExtracaoItem[] = [];
  const quantidade = validarQuantidade(opcoes.ultimos, 4);

  for (const [indice, numeroProcesso] of numeros.entries()) {
    registrarProgresso(opcoes, `[${indice + 1}/${numeros.length}] Extraindo ${numeroProcesso}.`);
    try {
      const resultado = await extrairProcesso(numeroProcesso, opcoes);
      const item: ResultadoLoteExtracaoItem = {
        numero_processo: numeroProcesso,
        ok: true,
        resultado_extracao: resumirExtracao(resultado),
        resumo_movimentacao: resumirMovimentacaoProcesso({
          processo: resultado.processo,
          quantidade,
          snapshot: resultado.diretorio_execucao,
          caminhoProcessoJson: resultado.caminho_processo_json,
        }),
      };
      resultados.push(item);
      if (opcoes.jsonl) {
        imprimirJsonl(item);
      }
    } catch (error) {
      const item: ResultadoLoteExtracaoItem = {
        numero_processo: numeroProcesso,
        ok: false,
        erro: error instanceof Error ? error.message : String(error),
      };
      resultados.push(item);
      if (opcoes.jsonl) {
        imprimirJsonl(item);
      } else {
        registrarProgresso(opcoes, `Falha ao extrair ${numeroProcesso}: ${item.erro}`);
      }
    }
  }

  if (opcoes.json && !opcoes.jsonl) {
    imprimirJson(resultados);
  } else if (!opcoes.jsonl) {
    const sucessos = resultados.filter((item) => item.ok).length;
    const falhas = resultados.length - sucessos;
    console.log(`Lote concluído: ${sucessos} sucesso(s), ${falhas} falha(s).`);
  }

  if (resultados.some((item) => !item.ok)) {
    process.exitCode = 1;
  }
}

async function executarLoteUltimasMovimentacoes(arquivo: string, opcoes: OpcoesCli) {
  const caminho = path.resolve(arquivo);
  const numeros = extrairNumerosProcessos(await readFile(caminho, "utf-8"));
  if (!numeros.length) {
    throw new Error(`Nenhum número de processo SEI encontrado em ${caminho}.`);
  }
  if (opcoes.saida) {
    throw new Error("Não use --saida com extração de últimas movimentações em lote.");
  }

  const resultados: ResultadoLoteMovimentacaoItem[] = [];
  let sessao = await abrirSessaoConsultaHistoricoSei();
  try {
    for (const [indice, numeroProcesso] of numeros.entries()) {
      registrarProgresso(opcoes, `[${indice + 1}/${numeros.length}] Consultando histórico remoto ${numeroProcesso}.`);
      try {
        let resumo: ResultadoResumoMovimentacao | undefined;
        let primeiroErro: unknown;
        for (let tentativa = 0; tentativa < 2; tentativa += 1) {
          try {
            resumo = await executarUltimasMovimentacoesRemotas(numeroProcesso, opcoes, sessao);
            break;
          } catch (error) {
            if (tentativa > 0) {
              throw new Error(
                `Falha após recriar a sessão: ${error instanceof Error ? error.message : String(error)}`,
                { cause: primeiroErro },
              );
            }
            primeiroErro = error;
            registrarProgresso(
              opcoes,
              `Consulta de ${numeroProcesso} falhou; recriando a sessão e tentando novamente.`,
            );
            await sessao.fechar();
            sessao = await abrirSessaoConsultaHistoricoSei();
          }
        }
        if (!resumo) {
          throw new Error(`Consulta de ${numeroProcesso} terminou sem resultado.`);
        }
        const item: ResultadoLoteMovimentacaoItem = {
          numero_processo: numeroProcesso,
          ok: true,
          resumo_movimentacao: resumo,
        };
        resultados.push(item);
        if (opcoes.jsonl) {
          imprimirJsonl(item);
        }
      } catch (error) {
        const item: ResultadoLoteMovimentacaoItem = {
          numero_processo: numeroProcesso,
          ok: false,
          erro: error instanceof Error ? error.message : String(error),
        };
        resultados.push(item);
        if (opcoes.jsonl) {
          imprimirJsonl(item);
        } else {
          registrarProgresso(opcoes, `Falha ao consultar ${numeroProcesso}: ${item.erro}`);
        }
      }
    }
  } finally {
    await sessao.fechar();
  }

  if (opcoes.json && !opcoes.jsonl) {
    imprimirJson(resultados);
  } else if (!opcoes.jsonl) {
    const sucessos = resultados.filter((item) => item.ok).length;
    const falhas = resultados.length - sucessos;
    console.log(`Lote concluído: ${sucessos} sucesso(s), ${falhas} falha(s).`);
  }

  if (resultados.some((item) => !item.ok)) {
    process.exitCode = 1;
  }
}

function traduzirErroCommander(texto: string) {
  return texto
    .replace(
      /error: option ('[^']+') argument ('[^']+') is invalid\. Allowed choices are (.+)\./g,
      "Erro: a opção $1 recebeu o argumento inválido $2. Valores permitidos: $3.",
    )
    .replace(/error: option ('[^']+') argument missing/g, "Erro: a opção $1 exige um argumento")
    .replace(/^error:/gm, "Erro:")
    .replace(/unknown command/g, "comando desconhecido")
    .replace(/unknown option/g, "opção desconhecida")
    .replace(/missing required argument/g, "argumento obrigatório ausente")
    .replace(
      /too many arguments\. Expected (\d+) arguments but got (\d+):/g,
      "argumentos em excesso. Esperados $1, mas recebidos $2:",
    )
    .replace(/Did you mean/g, "Você quis dizer");
}

function configurarApresentacao(programa: Command) {
  const ajudaPadrao = new Help();
  const traduzirMarcadores = (texto: string) =>
    texto
      .replaceAll("[options]", "[opções]")
      .replaceAll("[command]", "[comando]")
      .replaceAll("(choices:", "(valores:")
      .replaceAll("(default:", "(padrão:");

  programa
    .helpOption("-h, --help", "Exibe ajuda do comando")
    .helpCommand(false)
    .configureHelp({
      commandUsage: (comando) => traduzirMarcadores(ajudaPadrao.commandUsage(comando)),
      subcommandTerm: (comando) => traduzirMarcadores(ajudaPadrao.subcommandTerm(comando)),
      optionDescription: (opcao) => traduzirMarcadores(ajudaPadrao.optionDescription(opcao)),
      styleTitle(titulo) {
        return (
          {
            "Usage:": "Uso:",
            "Arguments:": "Argumentos:",
            "Options:": "Opções:",
            "Commands:": "Comandos:",
            "Global Options:": "Opções globais:",
          }[titulo] ?? titulo
        );
      },
    })
    .configureOutput({
      outputError: (texto, escrever) => escrever(traduzirErroCommander(texto)),
    });
}

function adicionarOpcoesExtracao(comando: Command) {
  return comando
    .option("--saida <dir>", "Define a pasta de saída")
    .option("--json", "Imprime o resultado em JSON")
    .option("--resumo", "Imprime uma versão resumida do resultado")
    .option("--quiet", "Suprime mensagens de progresso");
}

function adicionarOpcoesConsultaMovimentacoes(comando: Command) {
  return comando
    .option("--ultimos <quantidade>", "Quantidade de movimentações", lerQuantidade)
    .option("--json", "Imprime o resultado em JSON")
    .option("--quiet", "Suprime mensagens de progresso");
}

function adicionarOpcoesLote(comando: Command) {
  return adicionarOpcoesConsultaMovimentacoes(comando)
    .option("--jsonl", "Imprime um objeto JSON por linha")
    .option("--saida <dir>", "Define a pasta de saída");
}

function registrarComandosExtrair(programa: Command) {
  const extrair = programa
    .command("extrair")
    .description("Extrai dados de processos do SEI")
    .helpCommand(false);

  adicionarOpcoesExtracao(
    extrair.command("processo").description("Extrai um processo completo").argument("<numero>", "Número do processo SEI"),
  ).action(async (numero: string, opcoesBrutas: Partial<OpcoesCli>) => {
    const opcoes = normalizarOpcoes(opcoesBrutas);
    imprimirResultadoExtracao(await extrairProcesso(numero, opcoes), opcoes);
  });

  adicionarOpcoesLote(
    extrair.command("lote").description("Extrai processos listados em um arquivo").argument("<arquivo>"),
  ).action(async (arquivo: string, opcoesBrutas: Partial<OpcoesCli>) => {
    await executarLoteExtracao(arquivo, normalizarOpcoes(opcoesBrutas));
  });

  const ultimasMovimentacoes = adicionarOpcoesConsultaMovimentacoes(
    extrair
      .command("ultimas-movimentacoes")
      .description("Consulta o histórico remoto sem criar snapshot")
      .usage("[opções] <numero> | lote [opções] <arquivo>")
      .argument("<numero>"),
  );
  ultimasMovimentacoes.action(async (numero: string, opcoesBrutas: Partial<OpcoesCli>) => {
    const opcoes = normalizarOpcoes(opcoesBrutas);
    const resultado = await executarUltimasMovimentacoesRemotas(numero, opcoes);
    opcoes.json ? imprimirJson(resultado) : imprimirResumoMovimentacao(resultado);
  });

  adicionarOpcoesLote(
    ultimasMovimentacoes
      .command("lote")
      .description("Consulta processos listados em um arquivo")
      .argument("<arquivo>"),
  ).action(async (arquivo: string, _opcoesBrutas: Partial<OpcoesCli>, comando: Command) => {
    await executarLoteUltimasMovimentacoes(arquivo, normalizarOpcoes(comando.optsWithGlobals()));
  });
}

function registrarComandoAtualizar(programa: Command) {
  const atualizar = programa
    .command("atualizar")
    .description("Atualiza snapshots quando necessário")
    .helpCommand(false);
  adicionarOpcoesExtracao(
    atualizar
      .command("processo")
      .description("Compara e atualiza o snapshot de um processo")
      .argument("<numero>")
      .option("--snapshot <runDir>", "Usa uma pasta de execução específica")
      .option("--snapshot-auto", "Usa o snapshot local mais recente")
      .option("--ultimos <quantidade>", "Quantidade de movimentações", lerQuantidade),
  ).action(async (numero: string, opcoesBrutas: Partial<OpcoesCli>) => {
    const opcoes = normalizarOpcoes(opcoesBrutas);
    imprimirAtualizacao(await executarAtualizacaoProcesso(numero, opcoes), opcoes);
  });
}

function registrarComandoResumir(programa: Command) {
  const resumir = programa
    .command("resumir")
    .description("Resume dados de um processo")
    .helpCommand(false);
  resumir
    .command("movimentacao")
    .description("Resume as movimentações recentes")
    .argument("<numero-ou-run-dir>")
    .option("--ultimos <quantidade>", "Quantidade de movimentações", lerQuantidade)
    .option("--snapshot <runDir>", "Usa uma pasta de execução específica")
    .option("--snapshot-auto", "Usa o snapshot local mais recente")
    .option("--atualizar", "Compara com o SEI e atualiza quando necessário")
    .option("--json", "Imprime o resultado em JSON")
    .option("--quiet", "Suprime mensagens de progresso")
    .action(async (valor: string, opcoesBrutas: Partial<OpcoesCli>) => {
      const opcoes = normalizarOpcoes(opcoesBrutas);
      const resultado = await executarResumoMovimentacao(valor, opcoes);
      opcoes.json ? imprimirJson(resultado) : imprimirResumoMovimentacao(resultado);
    });
}

function registrarComandoLocalizar(programa: Command) {
  const localizar = programa
    .command("localizar")
    .description("Localiza recursos no SEI")
    .helpCommand(false);
  localizar
    .command("link")
    .description("Localiza o link estável de um processo")
    .argument("<numero>")
    .option("--json", "Imprime o resultado em JSON")
    .action(async (numero: string, opcoesBrutas: Partial<OpcoesCli>) => {
      const opcoes = normalizarOpcoes(opcoesBrutas);
      const resultado = await localizarLinkProcessoSei({ numeroProcesso: numero });
      if (opcoes.json) {
        imprimirJson(resultado);
        return;
      }
      console.log(`Processo ${resultado.numero_processo}`);
      console.log(`ID procedimento: ${resultado.sei_id_procedimento}`);
      console.log(`Link SEI: ${resultado.sei_link_processo}`);
    });
}

function registrarComandoVerificar(programa: Command) {
  const verificar = programa
    .command("verificar")
    .description("Verifica o estado de snapshots")
    .helpCommand(false);
  const atualizacao = verificar
    .command("atualizacao")
    .description("Verifica se há atualização remota")
    .helpCommand(false);
  const processo = atualizacao
    .command("processo")
    .description("Compara um processo remoto com um snapshot")
    .argument("<numero>")
    .option("--snapshot <runDir>", "Pasta de execução a comparar")
    .option("--json", "Imprime o resultado em JSON");

  processo.action(async (numero: string, opcoesBrutas: Partial<OpcoesCli>) => {
    const opcoes = normalizarOpcoes(opcoesBrutas);
    if (!opcoes.snapshot) {
      throw new Error("Informe --snapshot <runDir> para comparar com a fotografia local.");
    }

    const snapshot = path.resolve(opcoes.snapshot);
    const processoLocal = await carregarProcessoParaInspecao(snapshot);
    if (processoLocal.numero_processo !== numero) {
      throw new Error(`O snapshot informado é do processo ${processoLocal.numero_processo}, não de ${numero}.`);
    }

    const remoto = await consultarHistoricoProcessoSei({ numeroProcesso: numero });
    const resultado = compararAtualizacaoProcesso({
      processoLocal,
      historicoRemoto: remoto.historico,
      snapshot,
    });
    if (opcoes.json) {
      imprimirJson(resultado);
      return;
    }

    console.log(`Processo ${resultado.numero_processo}`);
    console.log(`Snapshot: ${resultado.snapshot}`);
    console.log(`Atualizado: ${resultado.atualizado ? "sim" : "não"}`);
    console.log(`Precisa extrair: ${resultado.precisa_extrair ? "sim" : "não"}`);
    console.log(`Motivo: ${resultado.motivo}`);
    if (resultado.ultima_movimentacao_local) {
      console.log("Última movimentação local:");
      imprimirEventoHistorico(resultado.ultima_movimentacao_local, 0);
    }
    if (resultado.ultima_movimentacao_remota) {
      console.log("Última movimentação remota:");
      imprimirEventoHistorico(resultado.ultima_movimentacao_remota, 0);
    }
  });
}

function registrarComandoLer(programa: Command) {
  const ler = programa
    .command("ler")
    .description("Cria snapshots a partir de arquivos locais")
    .helpCommand(false);
  adicionarOpcoesExtracao(
    ler
      .command("processo")
      .description("Lê um processo de um ZIP ou diretório")
      .argument("<numero>")
      .option("--zip <arquivo>", "Arquivo ZIP do processo")
      .option("--diretorio <dir>", "Diretório com os documentos do processo"),
  ).action(async (numero: string, opcoesBrutas: Partial<OpcoesCli>) => {
    const opcoes = normalizarOpcoes(opcoesBrutas);
    if (opcoes.zip && opcoes.diretorio) {
      throw new Error("Use apenas uma origem local: --zip ou --diretorio.");
    }
    if (!opcoes.zip && !opcoes.diretorio) {
      throw new Error("Informe --zip <arquivo> ou --diretorio <dir>.");
    }
    const resultado = opcoes.zip
      ? await lerZipProcesso({ numeroProcesso: numero, zip: opcoes.zip, saida: opcoes.saida })
      : await lerDiretorioProcesso({
          numeroProcesso: numero,
          diretorio: opcoes.diretorio!,
          saida: opcoes.saida,
        });
    imprimirResultadoExtracao(resultado, opcoes);
  });
}

async function carregarAlvoInspecao(valor: string) {
  const snapshot = await resolverSnapshotParaInspecao(valor);
  return {
    snapshot,
    processo: await carregarProcessoParaInspecao(snapshot),
  };
}

function registrarComandosInspecionar(programa: Command) {
  const inspecionar = programa
    .command("inspecionar")
    .description("Consulta um snapshot local")
    .helpCommand(false);

  inspecionar
    .command("ultima-atualizacao")
    .description("Mostra a última movimentação e o último documento")
    .argument("<numero-ou-run-dir>")
    .option("--json", "Imprime o resultado em JSON")
    .action(async (valor: string, opcoesBrutas: Partial<OpcoesCli>) => {
      const opcoes = normalizarOpcoes(opcoesBrutas);
      const { processo } = await carregarAlvoInspecao(valor);
      const resultado = inspecionarUltimaAtualizacao(processo);
      if (opcoes.json) {
        imprimirJson(resultado);
        return;
      }
      console.log(`Processo ${resultado.numero_processo}`);
      if (resultado.ultima_movimentacao) {
        console.log("Última movimentação:");
        imprimirEventoHistorico(resultado.ultima_movimentacao, 0);
      } else {
        console.log("Última movimentação: histórico indisponível.");
      }
      if (resultado.ultimo_documento) {
        console.log("Último documento:");
        imprimirDocumento(resultado.ultimo_documento, 0);
      }
    });

  inspecionar
    .command("documentos")
    .description("Lista os documentos mais recentes")
    .argument("<numero-ou-run-dir>")
    .option("--ultimos <quantidade>", "Quantidade de documentos", lerQuantidade)
    .option("--json", "Imprime o resultado em JSON")
    .action(async (valor: string, opcoesBrutas: Partial<OpcoesCli>) => {
      const opcoes = normalizarOpcoes(opcoesBrutas);
      const { processo } = await carregarAlvoInspecao(valor);
      const documentos = listarUltimosDocumentos(processo, validarQuantidade(opcoes.ultimos, 5));
      if (opcoes.json) {
        imprimirJson(documentos);
        return;
      }
      console.log(`Últimos ${documentos.length} documento(s) do processo ${processo.numero_processo}:`);
      documentos.forEach(imprimirDocumento);
    });

  inspecionar
    .command("historico")
    .description("Lista os eventos mais recentes do histórico")
    .argument("<numero-ou-run-dir>")
    .option("--ultimos <quantidade>", "Quantidade de eventos", lerQuantidade)
    .addOption(new Option("--formato <formato>", "Formato da saída").choices(["resumo"]))
    .option("--json", "Imprime o resultado em JSON")
    .action(async (valor: string, opcoesBrutas: Partial<OpcoesCli>) => {
      const opcoes = normalizarOpcoes(opcoesBrutas);
      const { snapshot, processo } = await carregarAlvoInspecao(valor);
      if (opcoes.formato === "resumo") {
        const resumo = resumirMovimentacaoProcesso({
          processo,
          quantidade: validarQuantidade(opcoes.ultimos, 10),
          snapshot,
          caminhoProcessoJson: caminhoProcessoJson(snapshot),
        });
        if (opcoes.json) {
          imprimirJson(resumo);
          return;
        }
        console.log(resumo.historico_usado.map(formatarEventoHistoricoParaResumo).join("\n"));
        return;
      }

      const historico = listarUltimosEventosHistorico(processo, validarQuantidade(opcoes.ultimos, 10));
      if (opcoes.json) {
        imprimirJson(historico);
        return;
      }
      console.log(`Últimos ${historico.length} evento(s) do processo ${processo.numero_processo}:`);
      historico.forEach(imprimirEventoHistorico);
    });

  const historicoRecente = inspecionar
    .command("historico-recente")
    .alias("resumo-movimentacao")
    .description("Resume as movimentações recentes")
    .argument("<numero-ou-run-dir>")
    .option("--ultimos <quantidade>", "Quantidade de eventos", lerQuantidade)
    .option("--json", "Imprime o resultado em JSON");

  historicoRecente.action(async (valor: string, opcoesBrutas: Partial<OpcoesCli>) => {
    const opcoes = normalizarOpcoes(opcoesBrutas);
    const { snapshot, processo } = await carregarAlvoInspecao(valor);
    const resultado = resumirMovimentacaoProcesso({
      processo,
      quantidade: validarQuantidade(opcoes.ultimos, 4),
      snapshot,
      caminhoProcessoJson: caminhoProcessoJson(snapshot),
    });
    opcoes.json ? imprimirJson(resultado) : imprimirResumoMovimentacao(resultado);
  });
}

function localizarSubcomando(programa: Command, nomes: string[]) {
  let atual = programa;
  for (const nome of nomes) {
    const proximo = atual.commands.find((comando) => comando.name() === nome || comando.aliases().includes(nome));
    if (!proximo) {
      throw new Error(`Comando desconhecido na ajuda: ${nomes.join(" ")}.`);
    }
    atual = proximo;
  }
  return atual;
}

export function criarPrograma() {
  const programa = new Command()
    .name("sei")
    .description("CLI para extrair, consultar e organizar snapshots de processos do SEI");
  configurarApresentacao(programa);

  registrarComandosExtrair(programa);
  registrarComandoAtualizar(programa);
  registrarComandoResumir(programa);
  registrarComandoLer(programa);
  registrarComandosInspecionar(programa);
  registrarComandoVerificar(programa);
  registrarComandoLocalizar(programa);

  programa
    .command("ajuda [comandos...]")
    .alias("help")
    .description("Exibe ajuda geral ou de um comando")
    .action((nomes: string[]) => localizarSubcomando(programa, nomes).outputHelp());

  programa.addHelpText(
    "after",
    `
Exemplos:
  sei extrair processo <numero> [--saida <dir>] [--json] [--resumo] [--quiet]
  sei extrair ultimas-movimentacoes <numero> [--ultimos 4] [--json] [--quiet]
  sei extrair ultimas-movimentacoes lote <arquivo.txt> [--ultimos 4] [--json|--jsonl] [--quiet]
  sei extrair lote <arquivo.txt> [--ultimos 4] [--json|--jsonl] [--quiet]
  sei atualizar processo <numero> (--snapshot <runDir>|--snapshot-auto) [--json] [--resumo] [--quiet]
  sei resumir movimentacao <numero|runDir> [--snapshot-auto] [--atualizar] [--json]
  sei verificar atualizacao processo <numero> --snapshot <runDir> [--json]

Variáveis para extrair do SEI:
  SEI_USUARIO
  SEI_SENHA
  SEI_BASE_URL=https://sei.ifpr.edu.br
  SEI_HEADLESS=true|false`,
  );

  programa.action(() => programa.outputHelp());
  return programa;
}

export async function executarCli(argv: string[]) {
  carregarEnvLocal();
  await criarPrograma().parseAsync(argv);
}
