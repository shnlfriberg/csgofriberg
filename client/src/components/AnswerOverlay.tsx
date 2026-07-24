import { ReactNode, useEffect } from 'react';
import { Globe, Crosshair, Calendar, Shield, Trophy } from 'lucide-react';
import { playerRoleLabel } from '../utils/playerRoles';
import ModalPortal from './ModalPortal';
import { useTranslation } from 'react-i18next';

export interface AnswerInfo {
  nickname: string;
  team: string;
  nationality: string;
  role?: string;
  majorChampionships?: number;
  majorAppearances?: number;
}

/** 选手信息表(答案卡片/查询结果共用) */
export function PlayerInfoTable({ answer }: { answer: AnswerInfo }) {
  const { t } = useTranslation();
  const rows: [ReactNode, string, ReactNode][] = [
    [<Shield size={14} key="i" />, t('player.team'), answer.team || '-'],
    [<Globe size={14} key="i" />, t('player.nationality'), answer.nationality],
    [<Crosshair size={14} key="i" />, t('player.role'), answer.role ? playerRoleLabel(answer.role) : '-'],
    [<Trophy size={14} key="i" />, t('player.majorChampionships'), answer.majorChampionships ?? 0],
    [<Calendar size={14} key="i" />, t('player.majorAppearances'), answer.majorAppearances ?? '-'],
  ];
  return (
    <table className="player-info-table">
      <tbody>
        {rows.map(([icon, label, value]) => (
          <tr key={label}>
            <td className="label">
              {icon}
              {label}
            </td>
            <td className="value">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface Props {
  title: string;
  answer: AnswerInfo | null;
  extra?: ReactNode;
  actions: ReactNode;
  onClose?: () => void;
}

/** 结算/答案遮罩卡片 */
export default function AnswerOverlay({ title, answer, extra, actions, onClose }: Props) {
  useEffect(() => {
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <ModalPortal>
      <div
        className="overlay"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose?.();
        }}
      >
        <div className="overlay-card" role="dialog" aria-modal="true">
          <h2>{title}</h2>
          {extra}
          {answer && (
            <>
              <p className="answer-name">{answer.nickname}</p>
              <PlayerInfoTable answer={answer} />
            </>
          )}
          <div className="btns">{actions}</div>
        </div>
      </div>
    </ModalPortal>
  );
}
