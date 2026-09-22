import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import { GuestSessionProvider } from './context/GuestSessionContext.jsx'
import { CartProvider } from './context/CartContext.jsx'
import { StaffAuthProvider } from './context/StaffAuthContext.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      {/* CartProvider was defined but never actually mounted anywhere —
          useCart() (MenuPage/CartPage/CheckoutPage) would have thrown at
          runtime the moment any of them rendered. Found while wiring in
          the staff-side providers below. */}
      <GuestSessionProvider>
        <CartProvider>
          <StaffAuthProvider>
            <App />
          </StaffAuthProvider>
        </CartProvider>
      </GuestSessionProvider>
    </BrowserRouter>
  </StrictMode>,
)
