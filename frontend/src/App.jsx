import { Routes, Route, Navigate } from 'react-router-dom';

import HomePage from './pages/HomePage';
import ScanPage from './pages/ScanPage';
import MenuPage from './pages/MenuPage';
import CartPage from './pages/CartPage';
import CheckoutPage from './pages/CheckoutPage';
import OrderStatusPage from './pages/OrderStatusPage';
import BillPage from './pages/BillPage';
import RequireGuestSession from './components/RequireGuestSession';
import RequireStaffAuth from './components/RequireStaffAuth';
import StaffLayout from './components/StaffLayout';
import LoginPage from './pages/staff/LoginPage';
import KitchenDisplayPage from './pages/staff/KitchenDisplayPage';
import OrdersPage from './pages/staff/OrdersPage';
import AdminDashboardPage from './pages/staff/AdminDashboardPage';

function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      {/* Matches the path a table's QR code actually encodes —
          GUEST_APP_BASE_URL + "/scan?code=" + qr_code_unique_id
          (backend/src/controllers/qrController.js). */}
      <Route path="/scan" element={<ScanPage />} />

      {/* Everything past the scan needs an active guest session — see
          components/RequireGuestSession.jsx. */}
      <Route element={<RequireGuestSession />}>
        <Route path="/menu" element={<MenuPage />} />
        <Route path="/cart" element={<CartPage />} />
        <Route path="/checkout" element={<CheckoutPage />} />
        <Route path="/order/:orderId" element={<OrderStatusPage />} />
        <Route path="/bill" element={<BillPage />} />
      </Route>

      {/* Staff — separate identity/auth entirely (see
          components/RequireStaffAuth.jsx), not guarded by
          RequireGuestSession above. */}
      <Route path="/staff/login" element={<LoginPage />} />
      <Route element={<RequireStaffAuth />}>
        <Route element={<StaffLayout />}>
          <Route path="/staff" element={<Navigate to="/staff/orders" replace />} />
          <Route path="/staff/kitchen" element={<KitchenDisplayPage />} />
          <Route path="/staff/orders" element={<OrdersPage />} />
          <Route path="/staff/admin" element={<AdminDashboardPage />} />
        </Route>
      </Route>
    </Routes>
  );
}

export default App;
