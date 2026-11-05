import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '../../src/i18n';
import AdminPresence from '../../src/components/admin/AdminPresence';

describe('admin presence strip', () => {
  it('shows every mode separately and updates counts without a total change', () => {
    const modes = { classicSingle: 1, classicDaily: 2, turtleSoup: 3, classicRooms: 4, relayRooms: 5, relay2v2Rooms: 6, locationDaily: 7, locationRandom: 8, locationRooms: 9, cardSingle: 10, cardDaily: 11, cardFriend: 12, cardRanked: 13 };
    const presence = { onlineUsers: 20, singleGames: 6, multiplayerRooms: 15, updatedAt: 0, modes };
    const view = render(<AdminPresence presence={presence} />);
    const strip = screen.getByRole('region', { name: '实时在线与各模式对局' });
    expect(within(strip).getAllByRole('term')).toHaveLength(14);
    expect(within(screen.getByText('在线人数').parentElement!).getByText('20')).toBeInTheDocument();
    expect(within(screen.getByText('卡牌天梯').parentElement!).getByText('13')).toBeInTheDocument();
    view.rerender(<AdminPresence presence={{ ...presence, modes: { ...modes, classicRooms: 3, relayRooms: 6 } }} />);
    expect(within(screen.getByText('经典对战').parentElement!).getByText('3')).toBeInTheDocument();
    expect(within(screen.getByText('接力').parentElement!).getByText('6')).toBeInTheDocument();
  });
  it('does not misrepresent unavailable categories as zero during loading or a rolling update', () => {
    const view = render(<AdminPresence presence={null} />);
    expect(screen.getAllByText('—')).toHaveLength(14);
    view.rerender(<AdminPresence presence={{ onlineUsers: 0, multiplayerRooms: 0, singleGames: 0, updatedAt: 0 }} />);
    expect(screen.getAllByText('—')).toHaveLength(13);
    expect(within(screen.getByText('在线人数').parentElement!).getByText('0')).toBeInTheDocument();
  });
});
