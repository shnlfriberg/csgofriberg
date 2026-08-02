import { RefreshCw, ScanSearch } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { currentLocale } from '../../i18n';

export type AnalysisSeverity = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
type DisplayPrimitive = string | number | boolean | null;

interface AnalysisItemBase {
  label: string;
  severity?: AnalysisSeverity;
}

type AnalysisItem =
  | (AnalysisItemBase & { type: 'metric'; value: DisplayPrimitive; displayValue?: string })
  | (AnalysisItemBase & { type: 'text'; displayValue: string })
  | (AnalysisItemBase & { type: 'badge'; displayValue: string })
  | (AnalysisItemBase & {
      type: 'table';
      columns: Array<{ key: string; label: string }>;
      rows: Array<Record<string, DisplayPrimitive>>;
    })
  | (AnalysisItemBase & {
      type: 'timeline';
      entries: Array<{ label: string; time?: string; description?: string; severity?: AnalysisSeverity }>;
    })
  | (AnalysisItemBase & {
      type: 'distribution';
      unit?: string;
      points: Array<{ label: string; value: number }>;
    });

export interface ExternalAnalysisView {
  schemaVersion: 1;
  requestId: string;
  analysisId: string;
  modelVersion: string;
  generatedAt: string;
  decision: {
    level: 'unknown' | 'low' | 'medium' | 'high' | 'critical';
    score: number;
    label: string;
    summary: string;
  };
  sections: Array<{ title: string; items: AnalysisItem[] }>;
}

function displayPrimitive(value: DisplayPrimitive): string {
  if (value == null) return '-';
  return String(value);
}

function severityClass(severity: AnalysisSeverity | undefined): string {
  return `severity-${severity ?? 'neutral'}`;
}

function AnalysisItemView({ item }: { item: AnalysisItem }) {
  if (item.type === 'metric') {
    return <div className={`admin-external-analysis-metric ${severityClass(item.severity)}`}>
      <span>{item.label}</span>
      <strong>{item.displayValue ?? displayPrimitive(item.value)}</strong>
    </div>;
  }
  if (item.type === 'text') {
    return <div className={`admin-external-analysis-text ${severityClass(item.severity)}`}>
      <strong>{item.label}</strong><p>{item.displayValue}</p>
    </div>;
  }
  if (item.type === 'badge') {
    return <div className="admin-external-analysis-badge-row">
      <span>{item.label}</span><b className={severityClass(item.severity)}>{item.displayValue}</b>
    </div>;
  }
  if (item.type === 'table') {
    return <div className={`admin-external-analysis-table-wrap ${severityClass(item.severity)}`}>
      <strong>{item.label}</strong>
      <div className="admin-external-analysis-table-scroll"><table><thead><tr>{item.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead><tbody>
        {item.rows.map((row, rowIndex) => <tr key={rowIndex}>{item.columns.map((column) => <td key={column.key}>{displayPrimitive(row[column.key] ?? null)}</td>)}</tr>)}
      </tbody></table></div>
    </div>;
  }
  if (item.type === 'timeline') {
    return <div className={`admin-external-analysis-timeline ${severityClass(item.severity)}`}>
      <strong>{item.label}</strong>
      <ol>{item.entries.map((entry, index) => <li className={severityClass(entry.severity)} key={`${entry.time ?? ''}:${entry.label}:${index}`}>
        <div><b>{entry.label}</b>{entry.time && <time>{entry.time}</time>}</div>
        {entry.description && <p>{entry.description}</p>}
      </li>)}</ol>
    </div>;
  }
  const maximum = Math.max(1, ...item.points.map((point) => Math.abs(point.value)));
  return <div className={`admin-external-analysis-distribution ${severityClass(item.severity)}`}>
    <strong>{item.label}</strong>
    <div>{item.points.map((point, index) => <div className="admin-external-analysis-point" key={`${point.label}:${index}`}>
      <span>{point.label}</span>
      <i><em style={{ width: `${Math.min(100, Math.abs(point.value) / maximum * 100)}%` }} /></i>
      <b>{point.value}{item.unit ?? ''}</b>
    </div>)}</div>
  </div>;
}

export default function ExternalAnalysisPanel({
  view,
  loading,
  onAnalyze,
}: {
  view: ExternalAnalysisView | null;
  loading: boolean;
  onAnalyze: (locale: string) => void;
}) {
  const { t } = useTranslation();
  if (!view) {
    return <div className="admin-external-analysis-empty">
      <ScanSearch size={28} />
      <p>{t('admin.analysisNotRun')}</p>
      <button className="btn" type="button" disabled={loading} onClick={() => onAnalyze(currentLocale())}>
        <ScanSearch size={16} />{loading ? t('admin.analysisRunning') : t('admin.runAnalysis')}
      </button>
    </div>;
  }
  const generated = new Date(view.generatedAt);
  return <div className="admin-external-analysis">
    <header className={`admin-external-analysis-decision level-${view.decision.level}`}>
      <div><span>{t('admin.analysisDecision')}</span><strong>{view.decision.label}</strong><p>{view.decision.summary}</p></div>
      <div className="admin-external-analysis-score"><span>{t('admin.analysisScore')}</span><b>{view.decision.score}</b><small>/ 100</small></div>
      <button className="btn btn-ghost" type="button" disabled={loading} onClick={() => onAnalyze(currentLocale())}>
        <RefreshCw size={16} />{loading ? t('admin.analysisRunning') : t('admin.rerunAnalysis')}
      </button>
    </header>
    <div className="admin-external-analysis-meta">
      <span>{t('admin.analysisModelVersion', { version: view.modelVersion })}</span>
      <span>{t('admin.analysisGeneratedAt', { time: Number.isNaN(generated.getTime()) ? '-' : generated.toLocaleString(currentLocale()) })}</span>
    </div>
    {view.sections.length ? <div className="admin-external-analysis-sections">{view.sections.map((section, index) => <section key={`${section.title}:${index}`}>
      <h3>{section.title}</h3>
      <div>{section.items.map((item, itemIndex) => <AnalysisItemView item={item} key={`${item.type}:${item.label}:${itemIndex}`} />)}</div>
    </section>)}</div> : <p className="muted">{t('admin.analysisNoSections')}</p>}
  </div>;
}
