# sei-cli

CLI em Bun/TypeScript para extrair, ler e inspecionar fotografias locais de processos do SEI.

O projeto automatiza acesso ao SEI com Playwright, baixa ou lê documentos locais, organiza os artefatos em uma pasta de execução e produz um `processo.json` estruturado para consulta posterior por pessoas, scripts ou agentes de IA.

## O que é o SEI

O [Sistema Eletrônico de Informações (SEI)](https://www.gov.br/servicoscompartilhados/pt-br/assuntos/gestao-documental/sistema-eletronico-de-informacoes-sei) é uma solução oficial do Governo Federal para produção e gestão de documentos e processos administrativos eletrônicos. Foi desenvolvido pelo Tribunal Regional Federal da 4ª Região (TRF-4) e é cedido gratuitamente a instituições públicas desde 2013, com foco em eficiência administrativa.

Este CLI não substitui o SEI nem altera processos: ele apenas ajuda a criar snapshots locais pesquisáveis de processos aos quais o usuário já tem acesso.

## Recursos

- Extrai processos diretamente do SEI usando `SEI_USUARIO` e `SEI_SENHA`.
- Lê exportações locais a partir de um `.zip` ou de um diretório de documentos.
- Gera uma fotografia local com documentos, logs, metadados, histórico e instruções de pesquisa.
- Lista últimos documentos, últimos eventos de histórico e última atualização do snapshot.
- Compara um snapshot local com o histórico remoto para indicar se uma nova extração é recomendada.
- Imprime resumos humanos em português, JSON completo com `--json`, JSON resumido com `--json --resumo` e JSON Lines em lote com `--jsonl`.
- Gera resumo operacional de movimentação com as últimas movimentações em texto pronto para reuso em sistemas como Notion, com opção de consulta leve ao histórico remoto sem baixar o processo completo.

## Requisitos

- [Bun](https://bun.sh/)
- Navegadores do Playwright instalados para comandos que acessam o SEI remoto

```bash
bun install
bunx playwright install
```

## Configuração

Os comandos que acessam o SEI remoto leem variáveis do ambiente atual e de `.env.local`:

```bash
SEI_USUARIO=seu_usuario
SEI_SENHA=sua_senha
SEI_BASE_URL=https://sei.ifpr.edu.br
SEI_HEADLESS=true
```

`SEI_BASE_URL` é opcional e usa `https://sei.ifpr.edu.br` por padrão. `SEI_HEADLESS` também é opcional e usa `true` por padrão.

Nunca versionar `.env.local`, snapshots do diretório `dados/`, documentos baixados, ZIPs de processo, screenshots de erro ou logs que possam conter informações internas. O `.gitignore` já cobre esses caminhos.

## Uso

Use um número de processo no formato `00000.000000/0000-00`.

```bash
bun run sei extrair processo 00000.000000/0000-00
bun run sei extrair processo 00000.000000/0000-00 --json --resumo
bun run sei extrair ultimas-movimentacoes 00000.000000/0000-00 --ultimos 4 --json
bun run sei extrair ultimas-movimentacoes lote processos.txt --ultimos 4 --jsonl
bun run sei extrair lote processos.txt --ultimos 4 --jsonl
bun run sei atualizar processo 00000.000000/0000-00 --snapshot-auto --json --resumo
bun run sei resumir movimentacao 00000.000000/0000-00 --ultimos 4 --json
bun run sei ler processo 00000.000000/0000-00 --zip processo.zip
bun run sei ler processo 00000.000000/0000-00 --diretorio documentos/
bun run sei localizar link 00000.000000/0000-00
```

Por padrão, cada comando imprime um resumo para leitura humana. Adicione `--json` para saída estruturada:

```bash
bun run sei extrair processo 00000.000000/0000-00 --json
```

Para automações, prefira `--json --resumo` quando o consumidor só precisa do caminho do snapshot, totais, link do processo e última movimentação. Isso evita imprimir o `processo.json` completo no terminal:

```bash
bun run sei extrair processo 00000.000000/0000-00 --json --resumo --quiet
```

Use `--saida <dir>` para escolher explicitamente a pasta de saída:

```bash
bun run sei ler processo 00000.000000/0000-00 --diretorio documentos/ --saida dados/sei/exemplo
```

Use `--quiet` para suprimir mensagens de progresso em `stderr`. Os logs do snapshot continuam sendo gravados em `logs/execucao.log`. Em modo normal, progresso e avisos são emitidos em `stderr`; JSON e JSONL ficam em `stdout`.

## Inspecionar um snapshot

Depois de uma extração, use a pasta de execução como `<runDir>`:

```bash
bun run sei inspecionar ultima-atualizacao <runDir>
bun run sei inspecionar documentos <runDir> --ultimos 5
bun run sei inspecionar historico <runDir> --ultimos 10
bun run sei inspecionar historico-recente <runDir> --ultimos 4
bun run sei resumir movimentacao <runDir> --ultimos 4
```

Todos os comandos de inspeção aceitam `--json`:

```bash
bun run sei inspecionar historico <runDir> --ultimos 50 --json
bun run sei inspecionar historico-recente <runDir> --ultimos 4 --json
bun run sei resumir movimentacao <runDir> --ultimos 4 --json
```

`historico-recente` e `resumir movimentacao` retornam também `data_abertura_sei`, `data_ultima_mov_sei`, `ultima_movimentacao_sei_texto`, `sei_link_processo` e `historico_usado`.

`extrair ultimas-movimentacoes` consulta o histórico remoto do SEI no momento da execução e retorna `fonte_dados: "historico_remoto"` e `consultado_remotamente_em`. Use esse comando quando o objetivo for atualizar campos operacionais como `Data Última mov. SEI` e `Última movimentação SEI`.

## Verificar atualização

Use `verificar atualizacao` quando já existe uma fotografia local e você precisa saber se ela ainda corresponde ao histórico remoto do SEI:

```bash
bun run sei verificar atualizacao processo 00000.000000/0000-00 --snapshot <runDir> --json
```

O comando acessa o SEI, consulta o histórico remoto completo e compara com o `historico` salvo em `<runDir>/processo.json`. Ele não baixa documentos nem altera o snapshot local.

A saída informa:

- `atualizado`: `true` quando o histórico remoto coincide com o snapshot.
- `precisa_extrair`: `true` quando há diferença e uma nova extração é recomendada.
- `ultima_movimentacao_local` e `ultima_movimentacao_remota`.
- totais de eventos de histórico local e remoto.

Quando `precisa_extrair` for `true`, gere uma nova fotografia:

```bash
bun run sei extrair processo 00000.000000/0000-00
```

Para fazer a verificação e extrair uma nova fotografia apenas quando necessário, use:

```bash
bun run sei atualizar processo 00000.000000/0000-00 --snapshot-auto --json --resumo
```

`--snapshot-auto` procura o snapshot mais recente em `dados/sei/<numero-processo>/`. Se não houver snapshot ou se o histórico remoto divergir, o comando faz nova extração e retorna o snapshot usado.

## Extração em lote

Para extrair vários processos, crie um arquivo de texto com um número de processo por linha. Comentários ou outros textos são ignorados; a CLI coleta os números no formato `00000.000000/0000-00`.

```bash
bun run sei extrair lote processos.txt --ultimos 4 --jsonl --quiet
```

Cada linha JSON contém `numero_processo`, `ok`, um resumo curto da extração e `resumo_movimentacao`. O comando continua nos processos seguintes quando um item falha e termina com código diferente de zero se qualquer processo falhar.

Para atualizar apenas dados de andamento, prefira o lote leve de últimas movimentações. Ele consulta o histórico remoto e não baixa o ZIP completo do processo:

```bash
bun run sei extrair ultimas-movimentacoes lote processos.txt --ultimos 4 --jsonl --quiet
```

Cada linha JSON contém `numero_processo`, `ok` e `resumo_movimentacao`. O campo `data_ultima_mov_sei` é obrigatório para itens `ok`; se o histórico remoto não retornar data, o item falha para evitar que integrações apaguem campos críticos.

Esse lote reutiliza uma sessão autenticada do SEI entre os processos. Cada consulta tem limite de 60 segundos; na primeira falha, a CLI recria a sessão e tenta o processo mais uma vez antes de registrar o erro e continuar o lote. A saída JSONL permanece incremental.

## Estrutura gerada

Cada execução cria uma pasta parecida com:

```text
dados/sei/<numero-processo>/<execucao>/
  AGENTS.md
  processo.json
  processo.zip
  documentos/
  logs/execucao.log
```

`processo.json` é o índice canônico do snapshot. Campos úteis:

- `numero_processo`, `tipo_processo`, `especificacao` e dados de origem.
- `ultima_movimentacao` e `historico` para movimentação administrativa.
- `documentos[].caminho_relativo` para abrir arquivos extraídos.
- `documentos[].assinantes_html` para nomes identificados em assinaturas HTML.
- `documentos[].unidade_sei` e `documentos[].caminho_hierarquico` quando a árvore do processo estiver disponível.

O `AGENTS.md` dentro da pasta de execução contém instruções específicas para pesquisar e citar aquele snapshot.

## Para agentes de IA

Este repositório foi pensado para produzir pastas que agentes de IA possam pesquisar depois. Cada snapshot é autocontido: ele inclui documentos, metadados, histórico, logs e um `AGENTS.md` próprio com instruções específicas para análise daquele processo.

Ao trabalhar com um snapshot gerado, comece por `<runDir>/processo.json` em vez de abrir documentos soltos. Use `ultima_movimentacao` e `historico` para entender o andamento administrativo, `documentos[].caminho_relativo` para localizar arquivos, `documentos[].assinantes_html` para nomes extraídos de assinaturas HTML e `documentos[].unidade_sei`/`documentos[].caminho_hierarquico` quando a árvore do processo estiver disponível.

Comandos úteis para orientar uma análise:

```bash
bun run sei inspecionar ultima-atualizacao <runDir> --json
bun run sei inspecionar documentos <runDir> --ultimos 20 --json
bun run sei inspecionar historico <runDir> --ultimos 50 --json
bun run sei inspecionar historico-recente <runDir> --ultimos 4 --json
bun run sei resumir movimentacao <runDir> --ultimos 4 --json
bun run sei verificar atualizacao processo 00000.000000/0000-00 --snapshot <runDir> --json
```

Para respostas baseadas em documentos do snapshot, cite o número SEI, o título e o caminho relativo do documento. Para respostas baseadas no andamento processual, cite também a data e a descrição do item em `historico[]`.

Para integrações automatizadas que precisam de andamento atual, use `extrair ultimas-movimentacoes ... --json` ou `extrair ultimas-movimentacoes lote ... --jsonl`, pois esses comandos consultam o histórico remoto. Para análise documental de uma fotografia já extraída, trate `processo.json` como fonte canônica e use `historico-recente`, `resumir movimentacao` ou `extrair lote --jsonl` em vez de parsear a saída JSON completa de `extrair processo --json`.

## Desenvolvimento

```bash
bun run typecheck
bun test
```

## Cuidados antes de publicar

Antes de abrir o repositório, confira:

- `git status --short` não mostra arquivos inesperados.
- `.env.local` existe apenas localmente e não está rastreado.
- `dados/`, `tmp/`, ZIPs, PDFs, documentos exportados e logs não estão rastreados.
- O histórico Git não contém credenciais, tokens, chaves privadas ou documentos reais.
- Exemplos públicos usam placeholders, não números de processos sensíveis.
