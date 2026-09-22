import { Navigate, Outlet } from 'react-router-dom';

import { useStaffAuth } from '../context/useStaffAuth';

// Guards every /staff/* route except /staff/login. Sent back to login
// rather than shown an error — same reasoning as RequireGuestSession.
export default function RequireStaffAuth() {
  const { session } = useStaffAuth();
  if (!session) {
    return <Navigate to="/staff/login" replace />;
  }
  return <Outlet />;
}
