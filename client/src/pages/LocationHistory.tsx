import { Navigate } from 'react-router-dom';

export default function LocationHistory() {
  return <Navigate to="/stats?variant=location" replace />;
}
