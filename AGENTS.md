## Very Important

- **ALPHA PHASE**: structural changes are welcome. Prefer the right architecture over local patches.
- This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Commits

- Mensagens de commit devem ser explicativas, não apenas uma linha curta.
- Use uma primeira linha objetiva com o resumo da mudança.
- Inclua um corpo explicando contexto, principais alterações e validação feita quando houver.

## Escopo deste arquivo

- Este `AGENTS.md` orienta contribuições neste repositório.
- Snapshots gerados pelo CLI têm seu próprio `AGENTS.md` dentro da pasta de execução, com instruções específicas para pesquisar e citar aquele processo.
- Não copie credenciais, documentos reais, ZIPs, logs ou dados de processos para arquivos versionados.

## Desenvolvimento

- Use Bun para executar scripts: `bun run typecheck` e `bun test`.
- Preserve comandos, mensagens e documentação em português quando estiver alterando a interface do CLI.
- Prefira fixtures fictícias em exemplos e testes, como `00000.000000/0000-00`.
- Trate `processo.json` como o índice canônico dos snapshots gerados.
