import { Routes, Route } from 'react-router-dom';

import HomePage from './pages/HomePage';
import ScanPage from './pages/ScanPage';

function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      {/* Matches the path a table's QR code actually encodes —
          GUEST_APP_BASE_URL + "/scan?code=" + qr_code_unique_id
          (backend/src/controllers/qrController.js). */}
      <Route path="/scan" element={<ScanPage />} />
    </Routes>
  );
}

export default App;
