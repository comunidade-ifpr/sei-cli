import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temporarios: string[] = [];

async function criarTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sei-cli-test-cli-"));
  temporarios.push(dir);
  return dir;
}

async function rodarCli(args: string[], cwd = process.cwd()) {
  const caminhoCli = path.resolve(import.meta.dir, "../src/cli.ts");
  const processo = Bun.spawn(["bun", "run", caminhoCli, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SEI_USUARIO: "",
      SEI_SENHA: "",
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(processo.stdout).text(),
    new Response(processo.stderr).text(),
    processo.exited,
  ]);
  return { stdout, stderr, code };
}

async function criarSnapshotComHistorico() {
  const base = await criarTempDir();
  const run = path.join(base, "run");
  await mkdir(run, { recursive: true });
  await writeFile(
    path.join(run, "processo.json"),
    `${JSON.stringify(
      {
        versao_schema: 1,
        numero_processo: "00000.000000/0000-00",
        extraido_em: "2026-06-16T12:00:00.000Z",
        origem: "diretorio-local",
        sei_link_processo: "https://sei.example/processo",
        historico: [
          {
            ocorrido_em: "2026-06-01T10:00:00-03:00",
            unidade: "UNIDADE/A",
            usuario: "100",
            descricao: "Processo recebido na unidade",
            ordem: 0,
          },
          {
            ocorrido_em: "2026-05-31T09:00:00-03:00",
            unidade: "UNIDADE/B",
            usuario: "101",
            descricao: "Processo remetido pela unidade anterior",
            ordem: 1,
          },
          {
            ocorrido_em: "2026-05-30T08:00:00-03:00",
            unidade: "UNIDADE/C",
            usuario: "102",
            descricao: "Processo público gerado",
            ordem: 2,
          },
        ],
        ultima_movimentacao: {
          ocorrido_em: "2026-06-01T10:00:00-03:00",
          unidade: "UNIDADE/A",
          usuario: "100",
          descricao: "Processo recebido na unidade",
          ordem: 0,
        },
        documentos: [],
        eventos: [],
        artefatos: {
          diretorio_documentos: "documentos",
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  return run;
}

async function criarSnapshotProcessoVazio(numeroProcesso: string) {
  const base = await criarTempDir();
  const run = path.join(base, "run");
  await mkdir(run, { recursive: true });
  await writeFile(
    path.join(run, "processo.json"),
    `${JSON.stringify(
      {
        versao_schema: 1,
        numero_processo: numeroProcesso,
        extraido_em: "2026-06-16T12:00:00.000Z",
        origem: "diretorio-local",
        historico: [],
        documentos: [],
        eventos: [],
        artefatos: {
          diretorio_documentos: "documentos",
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  return run;
}

afterEach(async () => {
  await Promise.all(temporarios.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CLI", () => {
  test("imprime ajuda em português", async () => {
    const resultado = await rodarCli(["ajuda"]);

    expect(resultado.code).toBe(0);
    expect(resultado.stdout).toContain("Uso: sei");
    expect(resultado.stdout).toContain("Opções:");
    expect(resultado.stdout).toContain("Comandos:");
    expect(resultado.stdout).toContain("sei extrair processo");
    expect(resultado.stdout).toContain("sei extrair lote");
    expect(resultado.stdout).toContain("sei extrair ultimas-movimentacoes lote");
    expect(resultado.stdout).toContain("sei resumir movimentacao");
    expect(resultado.stdout).toContain("sei verificar atualizacao processo");
    expect(resultado.stdout).toContain("Variáveis para extrair do SEI");
  });

  test("rejeita opções desconhecidas em português", async () => {
    const resultado = await rodarCli(["inspecionar", "ultima-atualizacao", ".", "--desconhecida"]);

    expect(resultado.code).toBe(1);
    expect(resultado.stderr).toContain("Erro: opção desconhecida '--desconhecida'");
  });

  test("documenta argumentos obrigatórios na ajuda gerada", async () => {
    const resultado = await rodarCli(["extrair", "processo", "--help"]);

    expect(resultado.code).toBe(0);
    expect(resultado.stdout).toContain("Uso: sei extrair processo [opções] <numero>");
    expect(resultado.stdout).not.toContain("[numero]");
  });

  test("traduz erros de valores inválidos e opções sem argumento", async () => {
    const formatoInvalido = await rodarCli([
      "inspecionar",
      "historico",
      ".",
      "--formato",
      "outro",
    ]);
    const argumentoAusente = await rodarCli(["inspecionar", "documentos", ".", "--ultimos"]);

    expect(formatoInvalido.code).toBe(1);
    expect(formatoInvalido.stderr).toContain("recebeu o argumento inválido 'outro'");
    expect(formatoInvalido.stderr).toContain("Valores permitidos: resumo");
    expect(argumentoAusente.code).toBe(1);
    expect(argumentoAusente.stderr).toContain("exige um argumento");
  });

  test("falha quando leitura local não recebe origem", async () => {
    const resultado = await rodarCli(["ler", "processo", "00000.000000/0000-00"]);

    expect(resultado.code).toBe(1);
    expect(resultado.stderr).toContain("Informe --zip");
  });

  test("falha quando verificação de atualização não recebe snapshot", async () => {
    const resultado = await rodarCli(["verificar", "atualizacao", "processo", "00000.000000/0000-00"]);

    expect(resultado.code).toBe(1);
    expect(resultado.stderr).toContain("Informe --snapshot");
  });

  test("executa leitura local com saída JSON", async () => {
    const base = await criarTempDir();
    const entrada = path.join(base, "entrada");
    const saida = path.join(base, "run");
    await mkdir(entrada, { recursive: true });
    await writeFile(
      path.join(entrada, "[1]-1234567 despacho.html"),
      "Documento assinado eletronicamente por Maria Silva, Coordenadora, em 25/05/2026, às 13:44",
      "utf-8",
    );

    const resultado = await rodarCli([
      "ler",
      "processo",
      "00000.000000/0000-00",
      "--diretorio",
      entrada,
      "--saida",
      saida,
      "--json",
    ]);

    expect(resultado.code).toBe(0);
    const json = JSON.parse(resultado.stdout);
    expect(json.processo.origem).toBe("diretorio-local");
    expect(json.processo.documentos[0].numero_sei).toBe("1234567");
  });

  test("executa leitura local com saída JSON resumida", async () => {
    const base = await criarTempDir();
    const entrada = path.join(base, "entrada");
    const saida = path.join(base, "run");
    await mkdir(entrada, { recursive: true });
    await writeFile(path.join(entrada, "[1]-1234567 despacho.html"), "conteúdo", "utf-8");

    const resultado = await rodarCli([
      "ler",
      "processo",
      "00000.000000/0000-00",
      "--diretorio",
      entrada,
      "--saida",
      saida,
      "--json",
      "--resumo",
    ]);

    expect(resultado.code).toBe(0);
    const json = JSON.parse(resultado.stdout);
    expect(json.numero_processo).toBe("00000.000000/0000-00");
    expect(json.processo).toBeUndefined();
    expect(json.documentos_total).toBe(1);
    expect(json.caminho_processo_json).toBe(path.join(saida, "processo.json"));
  });

  test("resume movimentação de um snapshot local", async () => {
    const run = await criarSnapshotComHistorico();

    const resultado = await rodarCli(["resumir", "movimentacao", run, "--ultimos", "2", "--json"]);

    expect(resultado.code).toBe(0);
    const json = JSON.parse(resultado.stdout);
    expect(json.numero_processo).toBe("00000.000000/0000-00");
    expect(json.data_abertura_sei).toBe("2026-05-30");
    expect(json.data_ultima_mov_sei).toBe("2026-06-01");
    expect(json.historico_usado).toHaveLength(2);
    expect(json.ultima_movimentacao_sei_texto).toContain("01/06/26: Processo recebido na unidade (UNIDADE/A)");
  });

  test("falha quando resumo recebe número e snapshot de outro processo", async () => {
    const run = await criarSnapshotProcessoVazio("00000.000000/0000-00");

    const resultado = await rodarCli([
      "resumir",
      "movimentacao",
      "11111.111111/1111-11",
      "--snapshot",
      run,
      "--json",
    ]);

    expect(resultado.code).toBe(1);
    expect(resultado.stderr).toContain("O snapshot informado é do processo 00000.000000/0000-00");
    expect(resultado.stderr).toContain("não de 11111.111111/1111-11");
  });

  test("inspeciona histórico em formato resumo", async () => {
    const run = await criarSnapshotComHistorico();

    const resultado = await rodarCli([
      "inspecionar",
      "historico",
      run,
      "--ultimos",
      "2",
      "--formato",
      "resumo",
    ]);

    expect(resultado.code).toBe(0);
    expect(resultado.stdout).toContain("01/06/26: Processo recebido na unidade (UNIDADE/A)");
    expect(resultado.stdout).toContain("31/05/26: Processo remetido pela unidade anterior (UNIDADE/B)");
  });

  test("inspeciona o snapshot mais recente usando apenas o número do processo", async () => {
    const cwd = await criarTempDir();
    const numeroProcesso = "00000.000000/0000-00";
    const run = path.join(cwd, "dados", "sei", "00000.000000_0000-00", "2026-06-16T12-00-00");
    await mkdir(run, { recursive: true });
    await writeFile(
      path.join(run, "processo.json"),
      `${JSON.stringify({
        versao_schema: 1,
        numero_processo: numeroProcesso,
        extraido_em: "2026-06-16T12:00:00.000Z",
        origem: "diretorio-local",
        historico: [],
        documentos: [],
        eventos: [],
        artefatos: { diretorio_documentos: "documentos" },
      })}\n`,
      "utf-8",
    );

    const resultado = await rodarCli(["inspecionar", "ultima-atualizacao", numeroProcesso, "--json"], cwd);

    expect(resultado.code).toBe(0);
    expect(JSON.parse(resultado.stdout).numero_processo).toBe(numeroProcesso);
  });

  test("explica quando não há snapshot local para o número informado", async () => {
    const cwd = await criarTempDir();
    const resultado = await rodarCli(
      ["inspecionar", "ultima-atualizacao", "00000.000000/0000-00"],
      cwd,
    );

    expect(resultado.code).toBe(1);
    expect(resultado.stderr).toContain("Nenhum snapshot local encontrado para o processo");
  });

  test("falha em lote sem números de processo", async () => {
    const base = await criarTempDir();
    const arquivo = path.join(base, "processos.txt");
    await writeFile(arquivo, "sem processos aqui\n", "utf-8");

    const resultado = await rodarCli(["extrair", "lote", arquivo, "--jsonl"]);

    expect(resultado.code).toBe(1);
    expect(resultado.stderr).toContain("Nenhum número de processo SEI encontrado");
  });

  test("falha em lote de últimas movimentações sem arquivo", async () => {
    const resultado = await rodarCli(["extrair", "ultimas-movimentacoes", "lote", "--jsonl"]);

    expect(resultado.code).toBe(1);
    expect(resultado.stderr).toContain("Erro: argumento obrigatório ausente 'arquivo'");
  });

  test("falha em lote de últimas movimentações sem números de processo", async () => {
    const base = await criarTempDir();
    const arquivo = path.join(base, "processos.txt");
    await writeFile(arquivo, "sem processos aqui\n", "utf-8");

    const resultado = await rodarCli(["extrair", "ultimas-movimentacoes", "lote", arquivo, "--jsonl"]);

    expect(resultado.code).toBe(1);
    expect(resultado.stderr).toContain("Nenhum número de processo SEI encontrado");
  });

  test("falha em lote quando --saida é informado", async () => {
    const base = await criarTempDir();
    const arquivo = path.join(base, "processos.txt");
    await writeFile(arquivo, "00000.000000/0000-00\n", "utf-8");

    const resultado = await rodarCli([
      "extrair",
      "lote",
      arquivo,
      "--saida",
      path.join(base, "saida"),
      "--jsonl",
    ]);

    expect(resultado.code).toBe(1);
    expect(resultado.stderr).toContain("Não use --saida com extração em lote");
  });

  test("preserva opções do subcomando de últimas movimentações em lote", async () => {
    const base = await criarTempDir();
    const arquivo = path.join(base, "processos.txt");
    await writeFile(arquivo, "00000.000000/0000-00\n", "utf-8");

    const resultado = await rodarCli([
      "extrair",
      "ultimas-movimentacoes",
      "lote",
      arquivo,
      "--saida",
      path.join(base, "saida"),
      "--json",
      "--quiet",
    ]);

    expect(resultado.code).toBe(1);
    expect(resultado.stderr).toContain("Não use --saida com extração de últimas movimentações em lote");
  });

  test("rejeita opções exclusivas de lote na consulta unitária", async () => {
    const resultado = await rodarCli([
      "extrair",
      "ultimas-movimentacoes",
      "00000.000000/0000-00",
      "--jsonl",
    ]);

    expect(resultado.code).toBe(1);
    expect(resultado.stderr).toContain("Erro: opção desconhecida '--jsonl'");
  });
});
