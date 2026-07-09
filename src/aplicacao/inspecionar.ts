import type {
  DocumentoProcesso,
  HistoricoProcessoItem,
  ProcessoExtraido,
  ResultadoExtracao,
  ResultadoExtracaoResumo,
  ResultadoResumoMovimentacao,
  ResultadoVerificacaoAtualizacao,
} from "../tipos";
import { ordenarDocumentosPorDataDesc } from "../dominio/documentos";
import { obterUltimaMovimentacao, ordenarHistoricoPorDataDesc } from "../dominio/historico";
import { formatarDataCurtaParaHumano, formatarDataIsoLocal } from "../dominio/tempo";
import { lerProcessoJson } from "../infra/arquivos";

export interface ResultadoUltimaAtualizacao {
  numero_processo: string;
  ultima_movimentacao?: HistoricoProcessoItem;
  ultimo_documento?: DocumentoProcesso;
}

export async function carregarProcessoParaInspecao(diretorioExecucao: string) {
  return lerProcessoJson(diretorioExecucao);
}

export function inspecionarUltimaAtualizacao(processo: ProcessoExtraido): ResultadoUltimaAtualizacao {
  return {
    numero_processo: processo.numero_processo,
    ultima_movimentacao: processo.ultima_movimentacao ?? obterUltimaMovimentacao(processo.historico),
    ultimo_documento: ordenarDocumentosPorDataDesc(processo.documentos)[0],
  };
}

export function listarUltimosDocumentos(processo: ProcessoExtraido, quantidade: number) {
  return ordenarDocumentosPorDataDesc(processo.documentos).slice(0, quantidade);
}

export function listarUltimosEventosHistorico(processo: ProcessoExtraido, quantidade: number) {
  return ordenarHistoricoPorDataDesc(processo.historico).slice(0, quantidade);
}

export function formatarEventoHistoricoParaResumo(evento: HistoricoProcessoItem) {
  const data = formatarDataCurtaParaHumano(evento.ocorrido_em);
  const unidade = evento.unidade ? ` (${evento.unidade})` : "";
  return `${data}: ${evento.descricao}${unidade}`;
}

export function resumirExtracao(resultado: ResultadoExtracao): ResultadoExtracaoResumo {
  return {
    numero_processo: resultado.processo.numero_processo,
    origem: resultado.processo.origem,
    extraido_em: resultado.processo.extraido_em,
    diretorio_execucao: resultado.diretorio_execucao,
    caminho_processo_json: resultado.caminho_processo_json,
    sei_base_url: resultado.processo.sei_base_url,
    sei_id_procedimento: resultado.processo.sei_id_procedimento,
    sei_link_processo: resultado.processo.sei_link_processo,
    tipo_processo: resultado.processo.tipo_processo,
    especificacao: resultado.processo.especificacao,
    documentos_total: resultado.processo.documentos.length,
    historico_total: resultado.processo.historico.length,
    ultima_movimentacao: resultado.processo.ultima_movimentacao ?? obterUltimaMovimentacao(resultado.processo.historico),
  };
}

export function resumirMovimentacaoProcesso(args: {
  processo: ProcessoExtraido;
  quantidade: number;
  fonteDados?: ResultadoResumoMovimentacao["fonte_dados"];
  consultadoRemotamenteEm?: string;
  snapshot?: string;
  caminhoProcessoJson?: string;
}): ResultadoResumoMovimentacao {
  const historicoOrdenado = ordenarHistoricoPorDataDesc(args.processo.historico);
  const historicoUsado = historicoOrdenado.slice(0, args.quantidade);
  const primeiraMovimentacao = historicoOrdenado.at(-1);
  const ultimaMovimentacao = historicoUsado[0];

  return {
    numero_processo: args.processo.numero_processo,
    fonte_dados: args.fonteDados ?? (args.snapshot ? "snapshot_local" : "extracao_processo"),
    consultado_remotamente_em: args.consultadoRemotamenteEm,
    snapshot: args.snapshot,
    caminho_processo_json: args.caminhoProcessoJson,
    extraido_em: args.processo.extraido_em,
    origem: args.processo.origem,
    sei_link_processo: args.processo.sei_link_processo,
    data_abertura_sei: formatarDataIsoLocal(primeiraMovimentacao?.ocorrido_em),
    data_ultima_mov_sei: formatarDataIsoLocal(ultimaMovimentacao?.ocorrido_em),
    ultima_movimentacao_sei_texto: historicoUsado.map(formatarEventoHistoricoParaResumo).join("\n"),
    historico_usado: historicoUsado,
    historico_total: args.processo.historico.length,
  };
}

function chaveMovimentacao(item?: HistoricoProcessoItem) {
  if (!item) {
    return undefined;
  }
  return [item.ocorrido_em, item.unidade ?? "", item.usuario ?? "", item.descricao].join("\u001f");
}

export function compararAtualizacaoProcesso(args: {
  processoLocal: ProcessoExtraido;
  historicoRemoto: HistoricoProcessoItem[];
  snapshot?: string;
}): ResultadoVerificacaoAtualizacao {
  const ultimaLocal = args.processoLocal.ultima_movimentacao ?? obterUltimaMovimentacao(args.processoLocal.historico);
  const ultimaRemota = obterUltimaMovimentacao(args.historicoRemoto);
  const historicoLocal = ordenarHistoricoPorDataDesc(args.processoLocal.historico).map(chaveMovimentacao);
  const historicoRemoto = ordenarHistoricoPorDataDesc(args.historicoRemoto).map(chaveMovimentacao);
  const atualizado =
    historicoLocal.length === historicoRemoto.length &&
    historicoLocal.every((chave, indice) => chave === historicoRemoto[indice]);

  return {
    numero_processo: args.processoLocal.numero_processo,
    atualizado,
    precisa_extrair: !atualizado,
    motivo: atualizado
      ? "O histórico remoto coincide com o histórico do snapshot local."
      : "O histórico remoto difere do histórico do snapshot local.",
    snapshot: args.snapshot,
    historico_local_total: args.processoLocal.historico.length,
    historico_remoto_total: args.historicoRemoto.length,
    ultima_movimentacao_local: ultimaLocal,
    ultima_movimentacao_remota: ultimaRemota,
  };
}
