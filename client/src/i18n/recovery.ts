export const recoveryTranslations = {
  zh: {
    title: '忘记密码', description: '填写用户名及该账号已验证绑定的邮箱，接收验证码并重置密码。验证码 10 分钟内有效。',
    email: '绑定邮箱', newPassword: '新密码（10–128 位）', submit: '重置密码', back: '返回登录',
    sent: '验证码已发送，请查收邮箱。若未收到，请确认邮箱已验证绑定，并检查垃圾邮件。',
    success: '账号 {{username}} 的密码重置成功，原有登录已失效，请使用该用户名和新密码登录。', codeFormat: '请输入 6 位数字验证码',
  },
  en: {
    title: 'Forgot password', description: 'Enter your username and its verified email to receive a password reset code. The code expires in 10 minutes.',
    email: 'Linked email', newPassword: 'New password (10–128 characters)', submit: 'Reset password', back: 'Back to login',
    sent: 'Code sent. Please check your inbox. If it does not arrive, confirm your email is verified and check spam.',
    success: 'Password reset for {{username}}. Previous sessions have expired. Log in with this username and your new password.', codeFormat: 'Enter the 6-digit code',
  },
  ja: {
    title: 'パスワードを忘れた場合', description: 'ユーザー名と登録済みの確認済みメールアドレスを入力してください。コードは10分間有効です。',
    email: '登録メールアドレス', newPassword: '新しいパスワード（10〜128文字）', submit: 'パスワードを再設定', back: 'ログインへ戻る',
    sent: 'コードを送信しました。届かない場合は確認済みのアドレスかどうかと迷惑メールをご確認ください。',
    success: '{{username}} のパスワードを再設定しました。以前のログインは無効です。このユーザー名と新しいパスワードでログインしてください。', codeFormat: '6桁のコードを入力してください',
  },
};
