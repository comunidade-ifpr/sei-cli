#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import path from "node:path";
import { formatarDataHoraParaHumano } from "./dominio/tempo";
import { validarNumeroProcessoSei } from "./dominio/texto";
import { carregarEnvLocal } from "./infra/env";
import { encontrarSnapshotMaisRecenteProcesso } from "./infra/arquivos";
import { lerDiretorioProcesso, lerZipProcesso } from "./infra/local";
import {
  abrirSessaoConsultaHistoricoSei,
  consultarHistoricoProcessoSei,
  extrairProcessoSei,
  localizarLinkProcessoSei,
  type SessaoConsultaHistoricoSei,
} from "./infra/playwrightSei";
import {
  carregarProcessoParaInspecao,
  compararAtualizacaoProcesso,
  formatarEventoHistoricoParaResumo,
  inspecionarUltimaAtualizacao,
  listarUltimosDocumentos,
  listarUltimosEventosHistorico,
  resumirExtracao,
  resumirMovimentacaoProcesso,
} from "./aplicacao/inspecionar";
import type {
  DocumentoProcesso,
  HistoricoProcessoItem,
  ProcessoExtraido,
  ResultadoAtualizacaoProcesso,
  ResultadoExtracao,
  ResultadoLoteExtracaoItem,
  ResultadoLoteMovimentacaoItem,
  ResultadoResumoMovimentacao,
} from "./tipos";

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

function obterValorFlag(args: string[], nome: string) {
  const indice = args.indexOf(nome);
  if (indice === -1) {
    return undefined;
  }
  return args[indice + 1];
}

function possuiFlag(args: string[], nome: string) {
  return args.includes(nome);
}

function lerOpcoes(args: string[]): OpcoesCli {
  const ultimos = obterValorFlag(args, "--ultimos");
  return {
    json: possuiFlag(args, "--json"),
    jsonl: possuiFlag(args, "--jsonl"),
    quiet: possuiFlag(args, "--quiet"),
    resumo: possuiFlag(args, "--resumo"),
    snapshotAuto: possuiFlag(args, "--snapshot-auto"),
    atualizar: possuiFlag(args, "--atualizar"),
    saida: obterValorFlag(args, "--saida"),
    zip: obterValorFlag(args, "--zip"),
    diretorio: obterValorFlag(args, "--diretorio"),
    snapshot: obterValorFlag(args, "--snapshot"),
    ultimos: ultimos ? Number.parseInt(ultimos, 10) : undefined,
    formato: obterValorFlag(args, "--formato"),
  };
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

function imprimirAjuda() {
  console.log(`Uso:
  sei extrair processo <numero> [--saida <dir>] [--json] [--resumo] [--quiet]
  sei extrair ultimas-movimentacoes <numero> [--ultimos 4] [--json] [--quiet]
  sei extrair ultimas-movimentacoes lote <arquivo.txt> [--ultimos 4] [--json|--jsonl] [--quiet]
  sei extrair lote <arquivo.txt> [--ultimos 4] [--json|--jsonl] [--quiet]
  sei atualizar processo <numero> (--snapshot <runDir>|--snapshot-auto) [--json] [--resumo] [--quiet]
  sei resumir movimentacao <numero|runDir> [--ultimos 4] [--snapshot <runDir>] [--snapshot-auto] [--atualizar] [--json]
  sei ler processo <numero> --zip <arquivo.zip> [--saida <dir>] [--json] [--resumo]
  sei ler processo <numero> --diretorio <dir> [--saida <dir>] [--json] [--resumo]
  sei inspecionar ultima-atualizacao <numero|runDir> [--json]
  sei inspecionar documentos <numero|runDir> [--ultimos 5] [--json]
  sei inspecionar historico <numero|runDir> [--ultimos 10] [--json] [--formato resumo]
  sei inspecionar historico-recente <numero|runDir> [--ultimos 4] [--json]
  sei verificar atualizacao processo <numero> --snapshot <runDir> [--json]
  sei localizar link <numero> [--json]

Automação:
  --resumo       Em comandos de extração, imprime JSON curto com caminhos e totais.
  --quiet        Suprime progresso em stderr; arquivos de log do snapshot continuam sendo gravados.
  --jsonl        Em lote, imprime uma linha JSON por processo.
  --snapshot-auto Usa o snapshot mais recente em dados/sei/<processo>/ quando aplicável.

Notas:
  extrair ultimas-movimentacoes consulta o histórico remoto do SEI e não depende de snapshot local.
  resumir movimentacao --snapshot-auto resume o snapshot local mais recente; use --atualizar para comparar com o SEI remoto.

Variáveis para extrair do SEI:
  SEI_USUARIO
  SEI_SENHA
  SEI_BASE_URL=https://sei.ifpr.edu.br
  SEI_HEADLESS=true|false`);
}

async function executar(args: string[]) {
  carregarEnvLocal();

  const [comando, alvo, valor] = args;
  const opcoes = lerOpcoes(args);

  if (!comando || comando === "ajuda" || comando === "help" || comando === "--help" || comando === "-h") {
    imprimirAjuda();
    return;
  }

  if (comando === "extrair") {
    if (alvo === "lote") {
      if (!valor) {
        throw new Error("Uso esperado: sei extrair lote <arquivo.txt>.");
      }
      await executarLoteExtracao(valor, opcoes);
      return;
    }

    if (alvo === "ultimas-movimentacoes") {
      if (!valor) {
        throw new Error("Uso esperado: sei extrair ultimas-movimentacoes <numero>.");
      }
      if (valor === "lote") {
        const arquivo = args[3];
        if (!arquivo || arquivo.startsWith("--")) {
          throw new Error("Uso esperado: sei extrair ultimas-movimentacoes lote <arquivo.txt>.");
        }
        await executarLoteUltimasMovimentacoes(arquivo, opcoes);
        return;
      }
      const resultado = await executarUltimasMovimentacoesRemotas(valor, opcoes);
      opcoes.json ? imprimirJson(resultado) : imprimirResumoMovimentacao(resultado);
      return;
    }

    if (alvo !== "processo" || !valor) {
      throw new Error("Uso esperado: sei extrair processo <numero>.");
    }
    const resultado = await extrairProcesso(valor, opcoes);
    imprimirResultadoExtracao(resultado, opcoes);
    return;
  }

  if (comando === "atualizar") {
    if (alvo !== "processo" || !valor) {
      throw new Error("Uso esperado: sei atualizar processo <numero> --snapshot-auto.");
    }
    const resultado = await executarAtualizacaoProcesso(valor, opcoes);
    imprimirAtualizacao(resultado, opcoes);
    return;
  }

  if (comando === "resumir") {
    if (alvo !== "movimentacao" || !valor) {
      throw new Error("Uso esperado: sei resumir movimentacao <numero|runDir>.");
    }
    const resultado = await executarResumoMovimentacao(valor, opcoes);
    opcoes.json ? imprimirJson(resultado) : imprimirResumoMovimentacao(resultado);
    return;
  }

  if (comando === "localizar") {
    if (alvo !== "link" || !valor) {
      throw new Error("Uso esperado: sei localizar link <numero>.");
    }
    const resultado = await localizarLinkProcessoSei({ numeroProcesso: valor });
    if (opcoes.json) {
      imprimirJson(resultado);
      return;
    }
    console.log(`Processo ${resultado.numero_processo}`);
    console.log(`ID procedimento: ${resultado.sei_id_procedimento}`);
    console.log(`Link SEI: ${resultado.sei_link_processo}`);
    return;
  }

  if (comando === "verificar") {
    const entidade = args[2];
    const numero = args[3];
    if (alvo !== "atualizacao" || entidade !== "processo" || !numero) {
      throw new Error("Uso esperado: sei verificar atualizacao processo <numero> --snapshot <runDir>.");
    }
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
    return;
  }

  if (comando === "ler") {
    if (alvo !== "processo" || !valor) {
      throw new Error("Uso esperado: sei ler processo <numero> --zip <arquivo> ou --diretorio <dir>.");
    }
    if (opcoes.zip && opcoes.diretorio) {
      throw new Error("Use apenas uma origem local: --zip ou --diretorio.");
    }
    if (!opcoes.zip && !opcoes.diretorio) {
      throw new Error("Informe --zip <arquivo> ou --diretorio <dir>.");
    }
    const resultado = opcoes.zip
      ? await lerZipProcesso({ numeroProcesso: valor, zip: opcoes.zip, saida: opcoes.saida })
      : await lerDiretorioProcesso({
          numeroProcesso: valor,
          diretorio: opcoes.diretorio!,
          saida: opcoes.saida,
        });
    imprimirResultadoExtracao(resultado, opcoes);
    return;
  }

  if (comando === "inspecionar") {
    if (!alvo || !valor) {
      throw new Error("Uso esperado: sei inspecionar <consulta> <numero|runDir>.");
    }
    const snapshot = await resolverSnapshotParaInspecao(valor);
    const processo = await carregarProcessoParaInspecao(snapshot);

    if (alvo === "ultima-atualizacao") {
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
      return;
    }

    if (alvo === "documentos") {
      const documentos = listarUltimosDocumentos(processo, validarQuantidade(opcoes.ultimos, 5));
      if (opcoes.json) {
        imprimirJson(documentos);
        return;
      }
      console.log(`Últimos ${documentos.length} documento(s) do processo ${processo.numero_processo}:`);
      documentos.forEach(imprimirDocumento);
      return;
    }

    if (alvo === "historico") {
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
      return;
    }

    if (alvo === "historico-recente" || alvo === "resumo-movimentacao") {
      const resultado = resumirMovimentacaoProcesso({
        processo,
        quantidade: validarQuantidade(opcoes.ultimos, 4),
        snapshot,
        caminhoProcessoJson: caminhoProcessoJson(snapshot),
      });
      opcoes.json ? imprimirJson(resultado) : imprimirResumoMovimentacao(resultado);
      return;
    }

    throw new Error(`Consulta desconhecida: ${alvo}.`);
  }

  throw new Error(`Comando desconhecido: ${comando}.`);
}

void executar(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
