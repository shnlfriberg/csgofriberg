import { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { trackUmamiEvent } from '../utils/analytics';

interface Props {
  to: string;
  icon: ReactNode;
  label: string;
  description: string;
  color: string;
  analyticsEvent: string;
}

/** 首页田字格入口卡片 */
export default function MenuCard({ to, icon, label, description, color, analyticsEvent }: Props) {
  return (
    <Link
      to={to}
      className="menu-card"
      style={{ ['--menu-color' as string]: color }}
      onClick={() => trackUmamiEvent(analyticsEvent)}
    >
      <span className="menu-icon">{icon}</span>
      <span className="menu-copy">
        <span className="menu-label">{label}</span>
        <span className="menu-description">{description}</span>
      </span>
      <ArrowUpRight className="menu-arrow" size={18} aria-hidden="true" />
    </Link>
  );
}
