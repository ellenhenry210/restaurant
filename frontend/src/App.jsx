import { Routes, Route } from 'react-router-dom';

import HomePage from './pages/HomePage';
import ScanPage from './pages/ScanPage';
import MenuPage from './pages/MenuPage';
import CartPage from './pages/CartPage';
import CheckoutPage from './pages/CheckoutPage';
import OrderStatusPage from './pages/OrderStatusPage';
import RequireGuestSession from './components/RequireGuestSession';

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
      </Route>
    </Routes>
  );
}

export default App;
