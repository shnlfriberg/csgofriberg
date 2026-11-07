/** Shared room-kernel texts (one multiplayer seat across all games). */
export const roomKernelTranslations = {
  zh: {
    occupiedTitle: '你已在另一个多人房间中',
    occupiedMessage: '你正在{{game}}的房间 {{code}}（{{status}}）。同一时间只能加入一个多人房间或对局。',
    occupiedReturn: '返回该房间',
    occupiedLeave: '离开并继续',
    occupiedLeaving: '正在离开…',
    occupiedLeaveFailed: '离开失败，请返回该房间后手动退出。',
    games: { classic: '猜选手对战', location: '图寻多人', 'card-link': '卡牌连接' },
    status: {
      waiting: '等待中', starting: '即将开始', preparing: '准备中', playing: '进行中',
      round_over: '回合结算', roundOver: '回合结算', finished: '已结束', cancelled: '已取消',
    },
  },
  en: {
    occupiedTitle: 'You are already in another multiplayer room',
    occupiedMessage: 'You are seated in {{game}} room {{code}} ({{status}}). You can only be in one multiplayer room or match at a time.',
    occupiedReturn: 'Return to that room',
    occupiedLeave: 'Leave it and continue',
    occupiedLeaving: 'Leaving…',
    occupiedLeaveFailed: 'Could not leave. Return to that room and leave it there.',
    games: { classic: 'Player Guess', location: 'Location', 'card-link': 'Card Link' },
    status: {
      waiting: 'waiting', starting: 'starting', preparing: 'preparing', playing: 'in progress',
      round_over: 'round results', roundOver: 'round results', finished: 'finished', cancelled: 'cancelled',
    },
  },
  ja: {
    occupiedTitle: '別のマルチプレイルームに参加中です',
    occupiedMessage: '{{game}}のルーム {{code}}（{{status}}）に参加中です。同時に参加できるマルチプレイは1つだけです。',
    occupiedReturn: 'そのルームに戻る',
    occupiedLeave: '退出して続ける',
    occupiedLeaving: '退出中…',
    occupiedLeaveFailed: '退出できませんでした。ルームに戻って退出してください。',
    games: { classic: '選手当て対戦', location: '場所当てマルチ', 'card-link': 'カード連結' },
    status: {
      waiting: '待機中', starting: '開始直前', preparing: '準備中', playing: '進行中',
      round_over: 'ラウンド結果', roundOver: 'ラウンド結果', finished: '終了', cancelled: '中止',
    },
  },
};
