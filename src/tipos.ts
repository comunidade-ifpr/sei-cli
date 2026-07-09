export type TipoDocumento = "PDF" | "HTML" | "Imagem" | "Arquivo binário";

export type OrigemExtracao = "playwright-sei" | "zip-local" | "diretorio-local";

export interface HistoricoProcessoItem {
  ocorrido_em: string;
  unidade?: string;
  usuario?: string;
  descricao: string;
  ordem: number;
}

export interface DocumentoProcesso {
  numero_sei?: string;
  titulo: string;
  nome_arquivo?: string;
  tipo_documento: TipoDocumento;
  mime_type?: string;
  tamanho_bytes?: number;
  sha256?: string;
  ordem_no_processo: number;
  criado_em?: string;
  criado_por?: string;
  modificado_em?: string;
  assinantes_html?: string[];
  resumo_textual?: string;
  unidade_sei?: string;
  caminho_hierarquico?: string[];
  caminho_relativo?: string;
}

export interface EventoExtracao {
  etapa: string;
  mensagem: string;
  nivel: "info" | "aviso" | "erro";
  criado_em: string;
}

export interface ProcessoExtraido {
  versao_schema: 1;
  numero_processo: string;
  extraido_em: string;
  origem: OrigemExtracao;
  sei_base_url?: string;
  sei_id_procedimento?: string;
  sei_link_processo?: string;
  tipo_processo?: string;
  especificacao?: string;
  ultima_movimentacao?: HistoricoProcessoItem;
  historico: HistoricoProcessoItem[];
  documentos: DocumentoProcesso[];
  eventos: EventoExtracao[];
  artefatos: {
    zip_original?: string;
    diretorio_documentos: string;
    log?: string;
    screenshot_falha?: string;
  };
}

export interface ResultadoExtracao {
  processo: ProcessoExtraido;
  diretorio_execucao: string;
  caminho_processo_json: string;
}

export interface ResultadoExtracaoResumo {
  numero_processo: string;
  origem: OrigemExtracao;
  extraido_em: string;
  diretorio_execucao: string;
  caminho_processo_json: string;
  sei_base_url?: string;
  sei_id_procedimento?: string;
  sei_link_processo?: string;
  tipo_processo?: string;
  especificacao?: string;
  documentos_total: number;
  historico_total: number;
  ultima_movimentacao?: HistoricoProcessoItem;
}

export interface ResultadoResumoMovimentacao {
  numero_processo: string;
  fonte_dados?: "historico_remoto" | "snapshot_local" | "extracao_processo";
  consultado_remotamente_em?: string;
  snapshot?: string;
  caminho_processo_json?: string;
  extraido_em: string;
  origem: OrigemExtracao;
  sei_link_processo?: string;
  data_abertura_sei?: string;
  data_ultima_mov_sei?: string;
  ultima_movimentacao_sei_texto: string;
  historico_usado: HistoricoProcessoItem[];
  historico_total: number;
}

export interface ResultadoVerificacaoAtualizacao {
  numero_processo: string;
  atualizado: boolean;
  precisa_extrair: boolean;
  motivo: string;
  snapshot?: string;
  historico_local_total: number;
  historico_remoto_total: number;
  ultima_movimentacao_local?: HistoricoProcessoItem;
  ultima_movimentacao_remota?: HistoricoProcessoItem;
}

export interface ResultadoAtualizacaoProcesso {
  numero_processo: string;
  atualizado: boolean;
  extracao_realizada: boolean;
  snapshot_usado?: string;
  verificacao?: ResultadoVerificacaoAtualizacao;
  resultado_extracao?: ResultadoExtracao | ResultadoExtracaoResumo;
  resumo_movimentacao?: ResultadoResumoMovimentacao;
}

export interface ResultadoLoteExtracaoItem {
  numero_processo: string;
  ok: boolean;
  resultado_extracao?: ResultadoExtracaoResumo;
  resumo_movimentacao?: ResultadoResumoMovimentacao;
  erro?: string;
}

export interface ResultadoLoteMovimentacaoItem {
  numero_processo: string;
  ok: boolean;
  resumo_movimentacao?: ResultadoResumoMovimentacao;
  erro?: string;
}
