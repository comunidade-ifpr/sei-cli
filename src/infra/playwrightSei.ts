import { writeFile } from "node:fs/promises";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Dialog,
  type Frame,
  type Locator,
  type Page,
} from "playwright";
import type { DocumentoProcesso, EventoExtracao } from "../tipos";
import {
  combinarDocumentosArvoreSei,
  normalizarDocumentoArvoreSei,
  type DocumentoArvoreSei,
  type DocumentoArvoreSeiBruto,
} from "../dominio/arvoreSei";
import { mapearMetadadosDocumentosPorHistorico } from "../dominio/autoriaDocumentalSei";
import {
  extrairHistoricoDasLinhasEstruturadasHistoricoSei,
  extrairHistoricoDasLinhasHistoricoSei,
  extrairResumoPaginacaoHistoricoSei,
  formatarResumoPaginacaoHistoricoSei,
  obterUltimaMovimentacao,
  type LinhaEstruturadaHistoricoSei,
} from "../dominio/historico";
import { agoraIso } from "../dominio/tempo";
import { textoCompacto, validarNumeroProcessoSei } from "../dominio/texto";
import { extrairIdProcedimentoSei, montarLinkProcessoSei } from "../dominio/links";
import {
  caminhoRelativoAoRun,
  escreverProcessoJson,
  extrairZipParaDiretorio,
  prepararDiretorioExecucao,
} from "./arquivos";
import { montarProcessoDeDiretorio } from "./local";

interface CredenciaisSei {
  usuario: string;
  senha: string;
}

interface MetadadosProcessoSei {
  tipo_processo?: string;
  especificacao?: string;
}

const PADROES_MENSAGEM_FALHA_AUTENTICACAO_SEI = [
  /usuário ou senha inválida\.?/i,
  /usuario ou senha invalida\.?/i,
  /autenticação em dois fatores/i,
  /autenticacao em dois fatores/i,
  /sessão bloqueada/i,
  /sessao bloqueada/i,
  /usuário bloqueado/i,
  /usuario bloqueado/i,
  /acesso negado/i,
  /captcha/i,
  /verificação anti-bot/i,
  /verificacao anti-bot/i,
] as const;

function lerBooleano(valor: string | undefined, padrao: boolean) {
  if (!valor) {
    return padrao;
  }
  return ["1", "true", "sim", "yes"].includes(valor.toLowerCase());
}

function lerCredenciaisSei(): CredenciaisSei {
  const usuario = process.env.SEI_USUARIO?.trim();
  const senha = process.env.SEI_SENHA?.trim();
  if (usuario && senha) {
    return { usuario, senha };
  }
  throw new Error(
    "Credenciais do SEI não encontradas. Defina SEI_USUARIO e SEI_SENHA em .env.local ou no ambiente atual.",
  );
}

function esperar(ms: number) {
  return new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), ms);
  });
}

function localizarFramesRelevantes(page: Page) {
  return [
    page.mainFrame(),
    ...page
      .frames()
      .filter((frame) =>
        ["ifrArvore", "ifrVisualizacao"].includes(frame.name()) ||
        /arvore|visualizacao|controlador\.php/i.test(frame.url()),
      ),
  ];
}

async function localizarPrimeiroLocator(page: Page, tentativas: Array<(frame: Frame) => Locator>) {
  for (const frame of localizarFramesRelevantes(page)) {
    for (const tentativa of tentativas) {
      const locator = tentativa(frame).first();
      if ((await locator.count().catch(() => 0)) > 0) {
        return locator;
      }
    }
  }
  return null;
}

async function localizarPrimeiroLocatorNaPagina(page: Page, tentativas: Array<() => Locator>) {
  for (const tentativa of tentativas) {
    const locator = tentativa().first();
    if ((await locator.count().catch(() => 0)) > 0) {
      return locator;
    }
  }
  return null;
}

function extrairMensagemFalhaAutenticacaoSei(textos: string[]) {
  for (const texto of textos) {
    const normalizado = textoCompacto(texto);
    for (const padrao of PADROES_MENSAGEM_FALHA_AUTENTICACAO_SEI) {
      const correspondencia = normalizado.match(padrao);
      if (correspondencia?.[0]) {
        return /[.!?]$/.test(correspondencia[0]) ? correspondencia[0] : `${correspondencia[0]}.`;
      }
    }
  }
  return undefined;
}

async function coletarTextosVisiveis(page: Page) {
  const textos = new Set<string>();
  for (const frame of localizarFramesRelevantes(page)) {
    const texto = await frame.locator("body").innerText().catch(() => "");
    const normalizado = textoCompacto(texto);
    if (normalizado) {
      textos.add(normalizado);
    }
  }
  return [...textos];
}

async function campoContemValor(campo: Locator, valor: string) {
  return campo.evaluate((elemento, valorEsperado) => {
    const input = elemento as HTMLInputElement & { _realfield?: HTMLInputElement };
    const campoReal =
      input._realfield ??
      (input.previousElementSibling instanceof HTMLInputElement
        ? input.previousElementSibling
        : null);
    return input.value === valorEsperado || campoReal?.value === valorEsperado;
  }, valor);
}

async function preencherCampo(campo: Locator, valor: string) {
  await campo.waitFor({ state: "visible" });
  await campo.scrollIntoViewIfNeeded();
  await campo.click();
  await campo.fill("");
  await campo.fill(valor);

  if (await campoContemValor(campo, valor)) {
    return;
  }

  await campo.evaluate((elemento, novoValor) => {
    const input = elemento as HTMLInputElement & { _realfield?: HTMLInputElement };
    const campoReal =
      input._realfield ??
      (input.previousElementSibling instanceof HTMLInputElement ? input.previousElementSibling : null);
    const definirValor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    const destino = campoReal ?? input;
    destino.focus();
    definirValor?.call(destino, "");
    destino.dispatchEvent(new Event("input", { bubbles: true }));
    definirValor?.call(destino, novoValor);
    destino.dispatchEvent(new Event("input", { bubbles: true }));
    destino.dispatchEvent(new Event("change", { bubbles: true }));
    destino.blur();
  }, valor);

  if (!(await campoContemValor(campo, valor))) {
    throw new Error("Falha ao preencher um campo de login do SEI.");
  }
}

async function resolverUrlAcao(locator: Locator, origem: Page, mensagemErro: string) {
  const href = await locator
    .evaluate((elemento) => {
      const hrefDireto = elemento.getAttribute("href");
      if (hrefDireto) {
        return hrefDireto;
      }
      return elemento.closest("a[href]")?.getAttribute("href") ?? null;
    })
    .catch(() => null);
  if (!href) {
    throw new Error(mensagemErro);
  }
  return new URL(href, origem.url()).toString();
}

async function abrirCopiaPaginaProcesso(page: Page) {
  const aba = await page.context().newPage();
  await aba.goto(page.url(), { waitUntil: "domcontentloaded" });
  await aba.waitForTimeout(1_000);
  return aba;
}

async function lerTextoSelecionado(locator: Locator) {
  const valor = await locator.evaluate((elemento) => {
    if (!(elemento instanceof HTMLSelectElement)) {
      return "";
    }
    return elemento.selectedOptions[0]?.textContent?.trim() ?? "";
  });
  return valor || undefined;
}

async function lerTextoCampo(locator: Locator) {
  const valor = await locator.inputValue().catch(() => "");
  const texto = valor.trim();
  return texto || undefined;
}

async function localizarProximaPaginaHistorico(frame: Frame) {
  const tentativas = [
    frame.locator('a[title*="Próxima Página" i]'),
    frame.locator('a[title*="Proxima Pagina" i]'),
    frame.getByRole("link", { name: /próxima página|proxima pagina/i }),
  ];

  for (const locator of tentativas) {
    const primeiro = locator.first();
    if ((await primeiro.count().catch(() => 0)) > 0) {
      return primeiro;
    }
  }

  return null;
}

async function coletarPaginaHistorico(frame: Frame) {
  return frame.evaluate(() => {
    const normalizarTexto = (valor?: string | null) => valor?.replace(/\s+/g, " ").trim() ?? "";
    const extrairDataHora = (valor: string) =>
      valor.match(/^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}\b/)?.[0];
    const texto = normalizarTexto(document.body.innerText);
    const linhasTabela = Array.from(document.querySelectorAll("table tr"));
    const linhas = linhasTabela
      .map((linha) => linha.textContent?.replace(/\s+/g, " ").trim() ?? "")
      .filter(Boolean);
    const linhasEstruturadas = linhasTabela
      .map((linha) => {
        const celulas = Array.from(linha.querySelectorAll("td, th"))
          .map((celula) => normalizarTexto(celula.textContent))
          .filter(Boolean);
        if (!celulas.length) {
          return null;
        }

        let dataHora = extrairDataHora(celulas[0] ?? "");
        let inicioMetadados = 1;
        if (
          !dataHora &&
          /^\d{2}\/\d{2}\/\d{4}$/.test(celulas[0] ?? "") &&
          /^\d{2}:\d{2}$/.test(celulas[1] ?? "")
        ) {
          dataHora = `${celulas[0]} ${celulas[1]}`;
          inicioMetadados = 2;
        }
        if (!dataHora) {
          return null;
        }

        const metadados = celulas.slice(inicioMetadados);
        if (metadados.length >= 3) {
          return {
            data_hora: dataHora,
            unidade: metadados[0],
            usuario: metadados[1],
            descricao: metadados.slice(2).join(" "),
          };
        }
        if (metadados.length >= 1) {
          return {
            data_hora: dataHora,
            descricao: metadados.join(" "),
          };
        }
        return null;
      })
      .filter(Boolean);

    return {
      linhas,
      linhas_estruturadas: linhasEstruturadas,
      resumo: texto.match(/Lista de Andamentos \([^)]*\)/i)?.[0] ?? null,
    };
  }) as Promise<{
    linhas: string[];
    linhas_estruturadas: LinhaEstruturadaHistoricoSei[];
    resumo: string | null;
  }>;
}

async function coletarIdProcedimentoProcesso(page: Page) {
  const urls = [
    page.url(),
    ...page.frames().map((frame) => frame.url()),
  ];

  for (const url of urls) {
    try {
      const idProcedimento = extrairIdProcedimentoSei(url);
      if (idProcedimento) {
        return idProcedimento;
      }
    } catch {
      // Ignora URLs internas incompletas ou especiais do navegador.
    }
  }

  for (const frame of localizarFramesRelevantes(page)) {
    const hrefs = await frame
      .locator(
        'a[href*="id_procedimento"], a[href*="id_protocolo"], form[action*="id_procedimento"], form[action*="id_protocolo"]',
      )
      .evaluateAll((elementos) =>
        elementos
          .map((elemento) => elemento.getAttribute("href") ?? elemento.getAttribute("action") ?? "")
          .filter(Boolean),
      )
      .catch(() => []);

    for (const href of hrefs) {
      try {
        const idProcedimento = extrairIdProcedimentoSei(new URL(href, frame.url()).toString());
        if (idProcedimento) {
          return idProcedimento;
        }
      } catch {
        // Ignora links relativos que não formem uma URL válida.
      }
    }
  }

  return undefined;
}

async function paginaProcessoContemNumero(page: Page, numeroProcesso: string) {
  const frameArvore = page.frames().find((frame) => frame.name() === "ifrArvore");
  const textoArvore = await frameArvore?.locator("body").innerText().catch(() => "");
  const numeroRaiz = textoArvore?.match(/\d{5}\.\d{6}\/\d{4}-\d{2}/)?.[0];
  if (numeroRaiz) {
    return numeroRaiz === numeroProcesso;
  }
  return false;
}

async function expandirArvoreCompleta(frameArvore: Pick<Frame, "evaluate">) {
  const prazoMaximoMs = 60_000;
  const inicioMs = Date.now();

  while (true) {
    const estadoArvore = await frameArvore.evaluate(`(() => {
      const pastas = Array.from(document.querySelectorAll('a[id^="anchorPASTA"]'));
      const pastasOcultas = [];
      const pastasCarregando = [];

      for (const ancora of pastas) {
        const pastaId = (ancora.id || '').replace(/^anchor/, '');
        const divPasta = document.getElementById('div' + pastaId);
        if (!divPasta) {
          continue;
        }

        const estilo = divPasta instanceof HTMLElement ? divPasta.style.display : '';
        const estaOculta = estilo === 'none';
        const estaCarregando = /Aguarde\\.\\.\\./i.test(divPasta.textContent || '');

        if (estaOculta) {
          pastasOcultas.push(pastaId);
          continue;
        }

        if (estaCarregando) {
          pastasCarregando.push(pastaId);
        }
      }

      return { pastasOcultas, pastasCarregando };
    })()`) as {
      pastasOcultas: string[];
      pastasCarregando: string[];
    };

    if (!estadoArvore.pastasOcultas.length && !estadoArvore.pastasCarregando.length) {
      break;
    }

    if (!estadoArvore.pastasOcultas.length) {
      if (Date.now() - inicioMs > prazoMaximoMs) {
        throw new Error(
          "A árvore do processo no SEI não terminou de carregar dentro do tempo esperado.",
        );
      }
      await esperar(250);
      continue;
    }

    const pastaId = estadoArvore.pastasOcultas[0]!;
    const pastaIdSerializada = JSON.stringify(pastaId);
    await frameArvore.evaluate(`(() => {
      const pastaId = ${pastaIdSerializada};
      const ancora =
        document.getElementById('anchor' + pastaId) || document.getElementById('ancjoin' + pastaId);
      if (ancora instanceof HTMLElement) {
        ancora.click();
      }
    })()`);

    while (true) {
      const pastaCarregada = await frameArvore.evaluate(`(() => {
        const pastaId = ${pastaIdSerializada};
        const divPasta = document.getElementById('div' + pastaId);
        if (!divPasta) {
          return true;
        }

        const estilo = divPasta instanceof HTMLElement ? divPasta.style.display : '';
        const estaOculta = estilo === 'none';
        const estaCarregando = /Aguarde\\.\\.\\./i.test(divPasta.textContent || '');
        return !estaOculta && !estaCarregando;
      })()`);

      if (pastaCarregada) {
        break;
      }

      if (Date.now() - inicioMs > prazoMaximoMs) {
        throw new Error(
          `A pasta ${pastaId} da árvore do processo no SEI não terminou de carregar dentro do tempo esperado.`,
        );
      }
      await esperar(250);
    }
  }
}

async function extrairMapaDocumentosArvoreSei(page: Page) {
  const frameArvore = page.frames().find((frame) => frame.name() === "ifrArvore");
  if (!frameArvore) {
    return {};
  }

  await expandirArvoreCompleta(frameArvore);
  const documentosBrutos = await frameArvore.evaluate(`(() => {
    const normalizarTexto = (valor) => valor?.replace(/\\s+/g, " ").trim() ?? "";
    const limparRotulo = (valor) =>
      normalizarTexto(valor).replace(/\\s*\\(\\d{6,}\\)\\s*$/u, "").trim();
    const lerCaminhoHierarquico = (ancoraDocumento) => {
      const segmentos = [];
      let elementoAtual = ancoraDocumento.parentElement;

      while (elementoAtual) {
        const divPasta = elementoAtual.closest('div.infraArvore[id^="divPASTA"]');
        if (!divPasta) {
          break;
        }

        const pastaId = (divPasta.id || '').replace(/^div/, '');
        const ancoraPasta = document.getElementById('anchor' + pastaId);
        const rotulo = limparRotulo(ancoraPasta?.textContent || ancoraPasta?.getAttribute('title'));
        if (rotulo) {
          segmentos.push(rotulo);
        }
        elementoAtual = divPasta.parentElement;
      }

      return segmentos.reverse();
    };

    const lerUnidadeSei = (documentoId) => {
      const ancoraUnidade = document.getElementById('anchorUG' + documentoId);
      return normalizarTexto(ancoraUnidade?.textContent);
    };

    return Array.from(document.querySelectorAll('a.infraArvoreNo[id^="anchor"]'))
      .flatMap((elemento) => {
        const documentoId = (elemento.id || '').replace(/^anchor/, '');
        if (!/^\\d+$/.test(documentoId)) {
          return [];
        }

        const texto = normalizarTexto(elemento.textContent);
        const titulo = normalizarTexto(elemento.getAttribute('title'));
        const conteudo = texto || titulo;
        if (!/^(.*?)\\s*(?:\\((\\d{6,})\\)|(\\d{6,}))\\s*$/u.test(conteudo)) {
          return [];
        }

        return [{
          texto: conteudo,
          unidade_sei: lerUnidadeSei(documentoId),
          caminho_hierarquico: lerCaminhoHierarquico(elemento),
        }];
      });
  })()`) as DocumentoArvoreSeiBruto[];

  const documentos = documentosBrutos
    .map((documento) => normalizarDocumentoArvoreSei(documento))
    .filter((documento): documento is DocumentoArvoreSei => documento !== null);

  return combinarDocumentosArvoreSei(documentos);
}

function aplicarMetadadosArvoreNosDocumentos(
  documentos: DocumentoProcesso[],
  mapaDocumentosArvore: Record<string, DocumentoArvoreSei>,
) {
  return documentos.map((documento) => {
    const documentoArvore = documento.numero_sei ? mapaDocumentosArvore[documento.numero_sei] : undefined;
    if (!documentoArvore) {
      return documento;
    }

    return {
      ...documento,
      titulo: documentoArvore.titulo || documento.titulo,
      unidade_sei: documentoArvore.unidade_sei ?? documento.unidade_sei,
      caminho_hierarquico: documentoArvore.caminho_hierarquico ?? documento.caminho_hierarquico,
    };
  });
}

export async function extrairProcessoSei(args: {
  numeroProcesso: string;
  saida?: string;
  quiet?: boolean;
}) {
  const numeroProcesso = validarNumeroProcessoSei(args.numeroProcesso);
  const baseUrl = process.env.SEI_BASE_URL?.trim() || "https://sei.ifpr.edu.br";
  const headless = lerBooleano(process.env.SEI_HEADLESS, true);
  const seletorPesquisa = "#txtPesquisaRapida";
  const paths = await prepararDiretorioExecucao({ numeroProcesso, saida: args.saida });
  const eventos: EventoExtracao[] = [];

  const registrar = async (etapa: string, mensagem: string, nivel: EventoExtracao["nivel"] = "info") => {
    const evento = { etapa, mensagem, nivel, criado_em: agoraIso() };
    eventos.push(evento);
    await writeFile(paths.caminhoLog, `[${evento.criado_em}] [${nivel}] [${etapa}] ${mensagem}\n`, {
      flag: "a",
    });
    if (!args.quiet) {
      console.error(mensagem);
    }
  };

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    await registrar("login", "Abrindo página inicial do SEI.");
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    const sessaoAtiva = async () => {
      for (const frame of localizarFramesRelevantes(page)) {
        if ((await frame.locator(seletorPesquisa).count().catch(() => 0)) > 0) {
          return true;
        }
      }
      return page.frames().some((frame) => ["ifrArvore", "ifrVisualizacao"].includes(frame.name()));
    };

    if (!(await sessaoAtiva())) {
      const credenciais = lerCredenciaisSei();
      const campoUsuario = await localizarPrimeiroLocatorNaPagina(page, [
        () => page.locator("#txtUsuario"),
        () => page.locator('input[name="txtUsuario"]'),
        () => page.locator('input[id*="usuario" i]'),
        () => page.getByLabel(/usuário|usuario/i),
      ]);
      const campoSenha = await localizarPrimeiroLocatorNaPagina(page, [
        () => page.locator("#pwdSenha"),
        () => page.locator("#txtSenha"),
        () => page.locator('input[type="password"]'),
        () => page.locator('input[id*="senha" i]'),
        () => page.getByLabel(/senha/i),
      ]);
      const botaoAcesso = await localizarPrimeiroLocatorNaPagina(page, [
        () => page.getByRole("button", { name: /acessar/i }),
        () => page.locator('input[type="submit"]'),
        () => page.locator('button[id*="acess" i]'),
      ]);

      if (!campoUsuario || !campoSenha || !botaoAcesso) {
        throw new Error(
          "Campos de login do SEI não localizados. A interface pode ter mudado; atualize o adaptador Playwright.",
        );
      }

      await registrar("login", "Preenchendo credenciais de acesso.");
      await preencherCampo(campoUsuario, credenciais.usuario);
      await preencherCampo(campoSenha, credenciais.senha);

      let mensagemDialogo: string | undefined;
      const aoAbrirDialogo = async (dialog: Dialog) => {
        mensagemDialogo = textoCompacto(dialog.message());
        await dialog.dismiss().catch(() => {});
      };
      page.on("dialog", aoAbrirDialogo);
      try {
        await botaoAcesso.click();
        const prazo = Date.now() + 12_000;
        while (Date.now() < prazo) {
          if (await sessaoAtiva()) {
            break;
          }
          const falha =
            mensagemDialogo ?? extrairMensagemFalhaAutenticacaoSei(await coletarTextosVisiveis(page));
          if (falha) {
            throw new Error(`Falha ao autenticar no SEI: ${falha}`);
          }
          await page.waitForLoadState("domcontentloaded", { timeout: 1_000 }).catch(() => {});
          await page.waitForTimeout(250);
        }
        if (!(await sessaoAtiva())) {
          throw new Error("Falha ao autenticar no SEI. Verifique credenciais, 2FA ou sessão bloqueada.");
        }
      } finally {
        page.off("dialog", aoAbrirDialogo);
      }
    }

    await registrar("pesquisa", `Pesquisando o processo ${numeroProcesso}.`);
    const campoPesquisa = await localizarPrimeiroLocator(page, [
      (frame) => frame.locator(seletorPesquisa),
    ]);
    if (!campoPesquisa) {
      throw new Error("Campo de pesquisa rápida do SEI não localizado.");
    }
    await campoPesquisa.fill("");
    await campoPesquisa.fill(numeroProcesso);
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => undefined),
      campoPesquisa.press("Enter"),
    ]);
    await page.waitForTimeout(2_000);

    if (!(await paginaProcessoContemNumero(page, numeroProcesso))) {
      throw new Error(
        `A pesquisa rápida do SEI não abriu uma página que contenha o processo ${numeroProcesso}.`,
      );
    }

    const idProcedimento = await coletarIdProcedimentoProcesso(page);
    if (idProcedimento) {
      await registrar("link", `Identificador interno do processo no SEI capturado: ${idProcedimento}.`);
    } else {
      await registrar(
        "link",
        "Identificador interno do processo no SEI não localizado; Link SEI não será gravado no snapshot.",
        "aviso",
      );
    }

    let zipOriginalRelativo: string | undefined;
    const botaoZip = await localizarPrimeiroLocator(page, [
      (frame) => frame.getByRole("link", { name: /zip/i }),
      (frame) => frame.getByRole("button", { name: /zip/i }),
      (frame) => frame.locator('[title*="ZIP" i]'),
      (frame) => frame.locator('[aria-label*="ZIP" i]'),
      (frame) => frame.getByText(/^ZIP$/i),
    ]);
    if (!botaoZip) {
      await registrar(
        "download",
        "Botão ou link de geração de ZIP não localizado no SEI; snapshot seguirá apenas com metadados e histórico.",
        "aviso",
      );
    } else {
      await registrar("download", "Solicitando ZIP completo do processo.");
      const primeiroDownload = page.waitForEvent("download", { timeout: 120_000 }).catch(() => null);
      await botaoZip.click();
      let download = await Promise.race([primeiroDownload, esperar(3_000)]);

      if (!download) {
        const gerarZip = await localizarPrimeiroLocator(page, [
          (frame) => frame.getByRole("button", { name: /gerar/i }),
          (frame) => frame.getByRole("link", { name: /gerar/i }),
          (frame) => frame.getByRole("button", { name: /confirmar|ok/i }),
          (frame) => frame.getByText(/gerar arquivo zip do processo/i),
        ]);
        if (gerarZip) {
          const downloadPromise = page.waitForEvent("download", { timeout: 120_000 }).catch(() => null);
          await gerarZip.click();
          download = await downloadPromise;
        } else {
          download = await primeiroDownload;
        }
      }

      if (download) {
        try {
          await download.saveAs(paths.caminhoZipOriginal);
          await registrar("download", `ZIP salvo em ${paths.caminhoZipOriginal}.`);
          await extrairZipParaDiretorio(paths.caminhoZipOriginal, paths.diretorioDocumentos);
          zipOriginalRelativo = caminhoRelativoAoRun(paths.diretorioExecucao, paths.caminhoZipOriginal);
        } catch (error) {
          await registrar(
            "download",
            `Não foi possível salvar ou extrair o ZIP do processo; snapshot seguirá apenas com metadados e histórico: ${error instanceof Error ? error.message : String(error)}`,
            "aviso",
          );
        }
      } else {
        await registrar(
          "download",
          "O SEI não iniciou o download do ZIP dentro do tempo esperado; snapshot seguirá apenas com metadados e histórico.",
          "aviso",
        );
      }
    }

    const mapaDocumentosArvore = await extrairMapaDocumentosArvoreSei(page).catch(async (error) => {
      await registrar(
        "arvore",
        `Não foi possível coletar a árvore do processo: ${error instanceof Error ? error.message : String(error)}`,
        "aviso",
      );
      return {};
    });
    if (Object.keys(mapaDocumentosArvore).length) {
      await registrar(
        "arvore",
        `${Object.keys(mapaDocumentosArvore).length} documento(s) identificados na árvore do SEI.`,
      );
    }

    const metadados: MetadadosProcessoSei = await coletarMetadadosProcesso(page).catch(async (error) => {
      await registrar(
        "metadados",
        `Não foi possível coletar metadados do processo: ${error instanceof Error ? error.message : String(error)}`,
        "aviso",
      );
      return {} satisfies MetadadosProcessoSei;
    });
    const historico = await coletarHistoricoProcesso(page).catch(async (error) => {
      await registrar(
        "historico",
        `Não foi possível coletar histórico do processo: ${error instanceof Error ? error.message : String(error)}`,
        "aviso",
      );
      return [];
    });
    if (historico.length) {
      await registrar("historico", `${historico.length} movimentação(ões) capturada(s) do histórico do processo.`);
    }

    const processo = await montarProcessoDeDiretorio({
      numeroProcesso,
      origem: "playwright-sei",
      diretorioExecucao: paths.diretorioExecucao,
      diretorioDocumentos: paths.diretorioDocumentos,
      zipOriginalRelativo,
      eventos,
    });
    processo.sei_base_url = baseUrl;
    processo.sei_id_procedimento = idProcedimento;
    processo.sei_link_processo = idProcedimento
      ? montarLinkProcessoSei(baseUrl, idProcedimento)
      : undefined;
    processo.tipo_processo = metadados.tipo_processo;
    processo.especificacao = metadados.especificacao;
    processo.historico = historico;
    processo.ultima_movimentacao = obterUltimaMovimentacao(historico);
    const metadadosPorDocumento = mapearMetadadosDocumentosPorHistorico(historico);
    processo.documentos = aplicarMetadadosArvoreNosDocumentos(
      processo.documentos,
      mapaDocumentosArvore,
    ).map((documento) => {
      const metadadosDocumento = documento.numero_sei
        ? metadadosPorDocumento[documento.numero_sei]
        : undefined;
      if (!metadadosDocumento) {
        return documento;
      }
      return {
        ...documento,
        criado_em: documento.criado_em ?? metadadosDocumento.criado_em,
        criado_por: documento.criado_por ?? metadadosDocumento.criado_por,
        modificado_em: documento.modificado_em ?? metadadosDocumento.modificado_em,
      };
    });

    return escreverProcessoJson({
      processo,
      diretorioExecucao: paths.diretorioExecucao,
      caminhoProcessoJson: paths.caminhoProcessoJson,
    });
  } catch (error) {
    await page.screenshot({ path: paths.caminhoScreenshotFalha, fullPage: true }).catch(() => {});
    await registrar("falha", error instanceof Error ? error.message : String(error), "erro").catch(
      () => {},
    );
    throw error;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

export async function localizarLinkProcessoSei(args: { numeroProcesso: string }) {
  const numeroProcesso = validarNumeroProcessoSei(args.numeroProcesso);
  const baseUrl = process.env.SEI_BASE_URL?.trim() || "https://sei.ifpr.edu.br";
  const headless = lerBooleano(process.env.SEI_HEADLESS, true);
  const seletorPesquisa = "#txtPesquisaRapida";

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    const sessaoAtiva = async () => {
      for (const frame of localizarFramesRelevantes(page)) {
        if ((await frame.locator(seletorPesquisa).count().catch(() => 0)) > 0) {
          return true;
        }
      }
      return page.frames().some((frame) => ["ifrArvore", "ifrVisualizacao"].includes(frame.name()));
    };

    if (!(await sessaoAtiva())) {
      const credenciais = lerCredenciaisSei();
      const campoUsuario = await localizarPrimeiroLocatorNaPagina(page, [
        () => page.locator("#txtUsuario"),
        () => page.locator('input[name="txtUsuario"]'),
        () => page.locator('input[id*="usuario" i]'),
        () => page.getByLabel(/usuário|usuario/i),
      ]);
      const campoSenha = await localizarPrimeiroLocatorNaPagina(page, [
        () => page.locator("#pwdSenha"),
        () => page.locator("#txtSenha"),
        () => page.locator('input[type="password"]'),
        () => page.locator('input[id*="senha" i]'),
        () => page.getByLabel(/senha/i),
      ]);
      const botaoAcesso = await localizarPrimeiroLocatorNaPagina(page, [
        () => page.getByRole("button", { name: /acessar/i }),
        () => page.locator('input[type="submit"]'),
        () => page.locator('button[id*="acess" i]'),
      ]);

      if (!campoUsuario || !campoSenha || !botaoAcesso) {
        throw new Error("Campos de login do SEI não localizados.");
      }

      await preencherCampo(campoUsuario, credenciais.usuario);
      await preencherCampo(campoSenha, credenciais.senha);
      await botaoAcesso.click();

      const prazo = Date.now() + 12_000;
      while (Date.now() < prazo && !(await sessaoAtiva())) {
        await page.waitForLoadState("domcontentloaded", { timeout: 1_000 }).catch(() => {});
        await page.waitForTimeout(250);
      }

      if (!(await sessaoAtiva())) {
        throw new Error("Falha ao autenticar no SEI. Verifique credenciais, 2FA ou sessão bloqueada.");
      }
    }

    const campoPesquisa = await localizarPrimeiroLocator(page, [
      (frame) => frame.locator(seletorPesquisa),
    ]);
    if (!campoPesquisa) {
      throw new Error("Campo de pesquisa rápida do SEI não localizado.");
    }

    await campoPesquisa.fill("");
    await campoPesquisa.fill(numeroProcesso);
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => undefined),
      campoPesquisa.press("Enter"),
    ]);
    await page.waitForTimeout(2_000);

    if (!(await paginaProcessoContemNumero(page, numeroProcesso))) {
      throw new Error(
        `A pesquisa rápida do SEI não abriu uma página que contenha o processo ${numeroProcesso}.`,
      );
    }

    const idProcedimento = await coletarIdProcedimentoProcesso(page);
    if (!idProcedimento) {
      throw new Error("Identificador interno do processo no SEI não localizado.");
    }

    return {
      numero_processo: numeroProcesso,
      sei_base_url: baseUrl,
      sei_id_procedimento: idProcedimento,
      sei_link_processo: montarLinkProcessoSei(baseUrl, idProcedimento),
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

export interface SessaoConsultaHistoricoSei {
  consultar(args: { numeroProcesso: string }): Promise<{
    numero_processo: string;
    sei_base_url: string;
    sei_id_procedimento: string | undefined;
    historico: Awaited<ReturnType<typeof coletarHistoricoProcesso>>;
  }>;
  fechar(): Promise<void>;
}

async function consultarHistoricoProcessoNaPagina(args: {
  numeroProcesso: string;
  page: Page;
  baseUrl: string;
}) {
  const numeroProcesso = validarNumeroProcessoSei(args.numeroProcesso);
  const { page, baseUrl } = args;
  const seletorPesquisa = "#txtPesquisaRapida";

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

  const sessaoAtiva = async () => {
    for (const frame of localizarFramesRelevantes(page)) {
      if ((await frame.locator(seletorPesquisa).count().catch(() => 0)) > 0) {
        return true;
      }
    }
    return page.frames().some((frame) => ["ifrArvore", "ifrVisualizacao"].includes(frame.name()));
  };

  if (!(await sessaoAtiva())) {
    const credenciais = lerCredenciaisSei();
    const campoUsuario = await localizarPrimeiroLocatorNaPagina(page, [
      () => page.locator("#txtUsuario"),
      () => page.locator('input[name="txtUsuario"]'),
      () => page.locator('input[id*="usuario" i]'),
      () => page.getByLabel(/usuário|usuario/i),
    ]);
    const campoSenha = await localizarPrimeiroLocatorNaPagina(page, [
      () => page.locator("#pwdSenha"),
      () => page.locator("#txtSenha"),
      () => page.locator('input[type="password"]'),
      () => page.locator('input[id*="senha" i]'),
      () => page.getByLabel(/senha/i),
    ]);
    const botaoAcesso = await localizarPrimeiroLocatorNaPagina(page, [
      () => page.getByRole("button", { name: /acessar/i }),
      () => page.locator('input[type="submit"]'),
      () => page.locator('button[id*="acess" i]'),
    ]);

    if (!campoUsuario || !campoSenha || !botaoAcesso) {
      throw new Error("Campos de login do SEI não localizados.");
    }

    await preencherCampo(campoUsuario, credenciais.usuario);
    await preencherCampo(campoSenha, credenciais.senha);
    await botaoAcesso.click();

    const prazo = Date.now() + 12_000;
    while (Date.now() < prazo && !(await sessaoAtiva())) {
      await page.waitForLoadState("domcontentloaded", { timeout: 1_000 }).catch(() => {});
      await page.waitForTimeout(250);
    }

    if (!(await sessaoAtiva())) {
      throw new Error("Falha ao autenticar no SEI. Verifique credenciais, 2FA ou sessão bloqueada.");
    }
  }

  const campoPesquisa = await localizarPrimeiroLocator(page, [
    (frame) => frame.locator(seletorPesquisa),
  ]);
  if (!campoPesquisa) {
    throw new Error("Campo de pesquisa rápida do SEI não localizado.");
  }

  await campoPesquisa.fill("");
  await campoPesquisa.fill(numeroProcesso);
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => undefined),
    campoPesquisa.press("Enter"),
  ]);
  await page.waitForTimeout(2_000);

  if (!(await paginaProcessoContemNumero(page, numeroProcesso))) {
    throw new Error(
      `A pesquisa rápida do SEI não abriu uma página que contenha o processo ${numeroProcesso}.`,
    );
  }

  return {
    numero_processo: numeroProcesso,
    sei_base_url: baseUrl,
    sei_id_procedimento: await coletarIdProcedimentoProcesso(page),
    historico: await coletarHistoricoProcesso(page),
  };
}

export async function abrirSessaoConsultaHistoricoSei(): Promise<SessaoConsultaHistoricoSei> {
  const baseUrl = process.env.SEI_BASE_URL?.trim() || "https://sei.ifpr.edu.br";
  const headless = lerBooleano(process.env.SEI_HEADLESS, true);
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

  try {
    browser = await chromium.launch({ headless });
    context = await browser.newContext();
    const page = await context.newPage();
    return {
      consultar: (args) => consultarHistoricoProcessoNaPagina({ ...args, page, baseUrl }),
      async fechar() {
        await context?.close().catch(() => {});
        await browser?.close().catch(() => {});
      },
    };
  } catch (error) {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    throw error;
  }
}

export async function consultarHistoricoProcessoSei(args: { numeroProcesso: string }) {
  const sessao = await abrirSessaoConsultaHistoricoSei();
  try {
    return await sessao.consultar(args);
  } finally {
    await sessao.fechar();
  }
}

async function coletarMetadadosProcesso(page: Page): Promise<MetadadosProcessoSei> {
  const aba = await abrirCopiaPaginaProcesso(page);
  try {
    const acao = await localizarPrimeiroLocator(aba, [
      (frame) => frame.getByRole("link", { name: /consultar(?:\/alterar)? processo/i }),
      (frame) => frame.locator('a[href*="acao=procedimento_alterar"]'),
      (frame) => frame.locator('a[href*="acao=procedimento_consultar"]'),
      (frame) => frame.locator('[title*="Consultar/Alterar Processo" i]'),
      (frame) => frame.locator('[title*="Consultar Processo" i]'),
    ]);
    if (!acao) {
      return {};
    }

    const url = await resolverUrlAcao(acao, aba, "Ação de consulta do processo sem URL.");
    await aba.goto(url, { waitUntil: "domcontentloaded" });
    await aba.waitForTimeout(500);
    const campoTipoProcesso = await localizarPrimeiroLocatorNaPagina(aba, [
      () => aba.getByRole("combobox", { name: /tipo do processo/i }),
      () => aba.locator('select[id*="tipo" i]'),
      () => aba.locator('select[name*="tipo" i]'),
    ]);
    const campoEspecificacao = await localizarPrimeiroLocatorNaPagina(aba, [
      () => aba.getByRole("textbox", { name: /especifica/i }),
      () => aba.locator('input[id*="especific" i]'),
      () => aba.locator('input[name*="especific" i]'),
    ]);

    return {
      tipo_processo: campoTipoProcesso ? await lerTextoSelecionado(campoTipoProcesso) : undefined,
      especificacao: campoEspecificacao ? await lerTextoCampo(campoEspecificacao) : undefined,
    };
  } finally {
    await aba.close().catch(() => {});
  }
}

async function coletarHistoricoProcesso(page: Page) {
  const aba = await abrirCopiaPaginaProcesso(page);
  try {
    const acao = await localizarPrimeiroLocator(aba, [
      (frame) => frame.getByRole("link", { name: /consultar andamento/i }),
      (frame) => frame.locator('[title*="Consultar Andamento" i]'),
      (frame) => frame.getByText(/consultar andamento/i),
    ]);
    if (!acao) {
      throw new Error("Ação Consultar Andamento não localizada na página do processo.");
    }

    await acao.click();
    await aba.waitForTimeout(1_000);
    const historicoCompleto = await localizarPrimeiroLocator(aba, [
      (frame) => frame.getByRole("link", { name: /ver histórico completo/i }),
      (frame) => frame.getByText(/ver histórico completo/i),
    ]);
    if (historicoCompleto) {
      await Promise.all([
        aba.waitForLoadState("domcontentloaded").catch(() => undefined),
        historicoCompleto.click(),
      ]);
      await aba.waitForTimeout(500);
    }

    const frameHistorico = aba.frames().find((frame) => frame.name() === "ifrVisualizacao");
    if (!frameHistorico) {
      throw new Error("Frame de visualização do histórico não localizado após abrir Consultar Andamento.");
    }

    const linhas: string[] = [];
    const linhasEstruturadas: LinhaEstruturadaHistoricoSei[] = [];

    while (true) {
      const paginaAtual = await coletarPaginaHistorico(frameHistorico);
      linhas.push(...paginaAtual.linhas);
      linhasEstruturadas.push(...paginaAtual.linhas_estruturadas);

      const resumoPaginacao = extrairResumoPaginacaoHistoricoSei(paginaAtual.resumo ?? undefined);
      if (!resumoPaginacao || resumoPaginacao.fim >= resumoPaginacao.total_registros) {
        break;
      }

      const proximaPagina = await localizarProximaPaginaHistorico(frameHistorico);
      if (!proximaPagina) {
        throw new Error(
          `Histórico do processo incompleto no SEI: a paginação indica ${formatarResumoPaginacaoHistoricoSei(resumoPaginacao)}, mas o link para a próxima página não foi localizado.`,
        );
      }

      const resumoAnterior = paginaAtual.resumo;
      await proximaPagina.click();

      let resumoMudou = false;
      for (let tentativa = 0; tentativa < 20; tentativa += 1) {
        await aba.waitForTimeout(250);
        const paginaSeguinte = await coletarPaginaHistorico(frameHistorico);
        if (paginaSeguinte.resumo && paginaSeguinte.resumo !== resumoAnterior) {
          resumoMudou = true;
          break;
        }
      }

      if (!resumoMudou) {
        throw new Error(
          `Histórico do processo incompleto no SEI: a paginação não avançou após clicar em próxima página (${formatarResumoPaginacaoHistoricoSei(resumoPaginacao)}).`,
        );
      }
    }

    const historicoEstruturado =
      extrairHistoricoDasLinhasEstruturadasHistoricoSei(linhasEstruturadas);
    const historico = historicoEstruturado.length
      ? historicoEstruturado
      : extrairHistoricoDasLinhasHistoricoSei(linhas);
    if (!historico.length) {
      throw new Error("A tela de histórico foi aberta, mas nenhuma movimentação pôde ser interpretada.");
    }

    return historico;
  } finally {
    await aba.close().catch(() => {});
  }
}
