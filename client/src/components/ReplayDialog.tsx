import { useEffect, useId, useRef, useState } from 'react';
import { BarChart3, ChevronLeft, ChevronRight, Swords, User, X } from 'lucide-react';
import Badge from './Badge';
import GuessBoard from './GuessBoard';
import { PlayerInfoTable } from './AnswerOverlay';
import ModalPortal from './ModalPortal';
import type { GuessFeedback, MatchReplay, MatchReplayRound, PlayerInfo, PlayerPerformanceStats } from '../types';
import { useTranslation } from 'react-i18next';
import { difficultyLabel } from '../utils/difficulty';
import PlayerStatsDialog from './PlayerStatsDialog';

export interface SingleReplay {
  type: 'single';
  id: number;
  mode: string;
  status: string;
  guessCount: number;
  createdAt: string;
  finishedAt: string;
  answer: PlayerInfo;
  guesses: GuessFeedback[];
}

export type MultiReplayRound = MatchReplayRound;

export interface MultiReplay extends MatchReplay {
  type: 'multi';
}

export type Replay = SingleReplay | MultiReplay;

function AnswerSection({ answer }: { answer: PlayerInfo }) {
  const { t } = useTranslation();
  return (
    <section className="replay-answer" aria-label={t('replay.answerLabel')}>
      <h3>{t('replay.correctAnswer', { name: answer.nickname })}</h3>
      <PlayerInfoTable
        answer={{
          nickname: answer.nickname,
          team: answer.team,
          nationality: `${answer.nationality}(${answer.region})`,
          role: answer.role,
          majorChampionships: answer.majorChampionships,
          majorAppearances: answer.majorAppearances,
        }}
      />
    </section>
  );
}

interface ReplayDialogProps {
  replay: Replay;
  onClose: () => void;
  opponentStats?: PlayerPerformanceStats | null;
  opponentStatsLoading?: boolean;
  onViewOpponentStats?: () => void;
}

export default function ReplayDialog({
  replay,
  onClose,
  opponentStats = null,
  opponentStatsLoading = false,
  onViewOpponentStats,
}: ReplayDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const [roundIndex, setRoundIndex] = useState(0);
  const [showOpponentStats, setShowOpponentStats] = useState(false);
  const roundCount = replay.type === 'multi' ? replay.rounds.length : 0;
  const activeRound = replay.type === 'multi' ? replay.rounds[roundIndex] : null;
  const opponentStatsOpen = Boolean(showOpponentStats && opponentStats && replay.type === 'multi');
  const opponentStatsOpenRef = useRef(opponentStatsOpen);
  opponentStatsOpenRef.current = opponentStatsOpen;

  useEffect(() => {
    setRoundIndex(0);
    setShowOpponentStats(false);
  }, [replay.id, replay.type]);

  useEffect(() => {
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (opponentStatsOpenRef.current) return;
      if (event.key === 'Escape') onClose();
      if (replay.type === 'multi' && replay.rounds.length > 0 && event.key === 'ArrowLeft') {
        setRoundIndex((current) => Math.max(0, current - 1));
      }
      if (replay.type === 'multi' && replay.rounds.length > 0 && event.key === 'ArrowRight') {
        setRoundIndex((current) => Math.min(replay.rounds.length - 1, current + 1));
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, replay]);

  return (
    <>
      <ModalPortal>
        <div className="replay-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}>
          <div
            className="replay-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-hidden={opponentStatsOpen || undefined}
          >
          <div className="replay-heading">
            <div>
              <h2 id={titleId}>{replay.type === 'single' ? t('replay.singleTitle') : t('replay.multiTitle')}</h2>
              <p>
                {replay.type === 'single'
                  ? t('replay.singleSummary', {
                    mode: difficultyLabel(t, replay.mode),
                    result: replay.status === 'won' ? t('common.win') : t('common.loss'),
                    count: replay.guessCount,
                  })
                  : t('replay.multiSummary', {
                    mode: difficultyLabel(t, replay.mode),
                    bo: replay.boType,
                    opponent: replay.opponent.displayId,
                    result: replay.result === 'won' ? t('common.win') : replay.result === 'lost' ? t('common.loss') : t('common.draw'),
                    score: `${replay.me.score}:${replay.opponent.score}`,
                  })}
              </p>
            </div>
            <button className="confirm-close" type="button" aria-label={t('replay.close')} onClick={onClose}>
              <X size={18} />
            </button>
          </div>
          <div className="replay-dialog-body">
            {replay.type === 'single' ? (
              <>
                <AnswerSection answer={replay.answer} />
                <section className="replay-guesses" aria-label={t('replay.guesses')}>
                  <h3>{t('replay.guesses')}</h3>
                  {replay.guesses.length
                    ? <GuessBoard guesses={replay.guesses} />
                    : <p className="muted">{t('replay.noGuesses')}</p>}
                </section>
              </>
            ) : (
              <div className="replay-rounds">
                {activeRound ? (
                  <section className="replay-round" key={activeRound.round}>
                    <div className="replay-round-heading">
                      <h3>{t('replay.round', { round: activeRound.round })}</h3>
                      <Badge
                        text={activeRound.winner === 'me' ? t('replay.meWon') : activeRound.winner === 'opponent' ? t('replay.opponentWon') : t('common.draw')}
                        color={activeRound.winner === 'me' ? 'green' : 'gray'}
                      />
                    </div>
                    <AnswerSection answer={activeRound.answer} />
                    <div className="replay-sides">
                      <div className="replay-side">
                        <h4><User size={15} />{t('replay.mySide')}</h4>
                        {activeRound.me.guesses.length
                          ? <GuessBoard guesses={activeRound.me.guesses} />
                          : <p className="muted">{t('replay.noRoundGuesses')}</p>}
                      </div>
                      <div className="replay-side">
                        <h4>
                          <Swords size={15} />
                          <span>{replay.opponent.displayId}</span>
                          {onViewOpponentStats && (
                            <button
                              type="button"
                              className="player-stats-trigger"
                              aria-label={t('multi.viewPlayerStats', { player: replay.opponent.displayId })}
                              title={t('multi.viewStats')}
                              disabled={opponentStatsLoading}
                              onClick={() => {
                                setShowOpponentStats(true);
                                if (!opponentStats) onViewOpponentStats();
                              }}
                            >
                              {opponentStatsLoading ? <span className="player-stats-spinner" /> : <BarChart3 size={16} />}
                            </button>
                          )}
                        </h4>
                        {activeRound.opponent.guesses.length
                          ? <GuessBoard guesses={activeRound.opponent.guesses} />
                          : <p className="muted">{t('replay.noRoundGuesses')}</p>}
                      </div>
                    </div>
                  </section>
                ) : <p className="muted">{t('replay.noRounds')}</p>}
                {roundCount > 0 && (
                  <div className="replay-round-pagination" aria-label={t('replay.pagination')}>
                    <button className="btn btn-ghost" type="button" aria-label={t('replay.previousRound')} title={t('replay.previousRound')} disabled={roundIndex === 0} onClick={() => setRoundIndex((current) => Math.max(0, current - 1))}>
                      <ChevronLeft size={17} />
                    </button>
                    <span>{t('replay.roundPage', { current: roundIndex + 1, total: roundCount })}</span>
                    <button className="btn btn-ghost" type="button" aria-label={t('replay.nextRound')} title={t('replay.nextRound')} disabled={roundIndex >= roundCount - 1} onClick={() => setRoundIndex((current) => Math.min(roundCount - 1, current + 1))}>
                      <ChevronRight size={17} />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          </div>
        </div>
      </ModalPortal>
      {opponentStatsOpen && opponentStats && replay.type === 'multi' && (
        <PlayerStatsDialog
          view={{ displayId: replay.opponent.displayId, stats: opponentStats }}
          onClose={() => setShowOpponentStats(false)}
        />
      )}
    </>
  );
}
