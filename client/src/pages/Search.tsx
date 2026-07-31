import { useState } from 'react';
import { Search as SearchIcon, CircleDot } from 'lucide-react';
import Page from '../components/Page';
import GuessInputBar from '../components/GuessInputBar';
import { PlayerInfoTable } from '../components/AnswerOverlay';
import { api, errMsg } from '../api/client';
import { PlayerInfo } from '../types';
import { toast } from '../components/Toast';
import { useTranslation } from 'react-i18next';

/** 查选手:底部输入 + 自动补全,选中后在上方展示选手卡片(原版布局) */
export default function Search() {
  const { t } = useTranslation();
  const [player, setPlayer] = useState<PlayerInfo | null>(null);

  const lookup = async (nickname: string) => {
    try {
      const res = await api.get<PlayerInfo[]>('/players', {
        params: { search: nickname },
      });
      const exact =
        res.data.find((p) => p.nickname.toLowerCase() === nickname.toLowerCase()) ??
        res.data[0] ??
        null;
      setPlayer(exact);
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <Page
      title={t('search.title')}
      icon={<SearchIcon size={17} />}
      dock={
        <GuessInputBar
          onPick={(p) => void lookup(p.nickname)}
          placeholder={t('search.placeholder')}
          buttonText={t('search.button')}
        />
      }
    >
      <div className="player-search-content">
        {player ? (
          <div className="card">
            <h3>
              <CircleDot size={15} color={player.isActive ? '#16a34a' : '#9aa3b2'} />
              {player.nickname}
              <span className="muted" style={{ fontWeight: 400 }}>
                {player.isActive ? t('common.active') : t('common.retired')} · {t('search.age', { age: player.age })}
              </span>
            </h3>
            <PlayerInfoTable
              answer={{
                nickname: player.nickname,
                team: player.team,
                nationality: player.nationality,
                region: player.region,
                role: player.role,
                majorChampionships: player.majorChampionships,
                majorAppearances: player.majorAppearances,
              }}
            />
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--text-light)' }}>
            <SearchIcon size={32} strokeWidth={1.5} />
            <p>{t('search.empty')}</p>
            <p style={{ fontSize: '0.8rem' }}>{t('search.fuzzy')}</p>
          </div>
        )}
      </div>
    </Page>
  );
}
