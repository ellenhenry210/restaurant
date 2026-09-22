import { NavLink, Outlet, useNavigate } from 'react-router-dom';

import { useStaffAuth } from '../context/useStaffAuth';

const NAV_LINK_CLASS = ({ isActive }) =>
  `rounded-md px-md py-2 text-sm font-medium ${isActive ? 'bg-brand text-white' : 'text-ink-secondary hover:bg-white'}`;

// Every link is shown to every role — the backend's authorize() is the
// real gate (each page handles its own 403s), this is just navigation,
// not a security boundary.
export default function StaffLayout() {
  const { session, clearSession } = useStaffAuth();
  const navigate = useNavigate();

  function handleLogout() {
    clearSession();
    navigate('/staff/login', { replace: true });
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-border bg-surface px-md py-sm">
        <nav className="flex gap-xs">
          <NavLink to="/staff/kitchen" className={NAV_LINK_CLASS}>
            Kitchen
          </NavLink>
          <NavLink to="/staff/orders" className={NAV_LINK_CLASS}>
            Orders
          </NavLink>
          <NavLink to="/staff/admin" className={NAV_LINK_CLASS}>
            Admin
          </NavLink>
        </nav>
        <div className="flex items-center gap-sm">
          <span className="text-xs text-ink-secondary">
            {session.user.name} · <span className="font-mono">{session.user.role}</span>
          </span>
          <button type="button" onClick={handleLogout} className="text-xs font-medium text-danger">
            Log out
          </button>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
