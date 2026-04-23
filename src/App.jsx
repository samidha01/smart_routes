import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import Navbar from './components/Navbar'
import LandingPage from './pages/LandingPage'
import Dashboard from './pages/Dashboard'
import About from './pages/About'

// Show navbar on all pages; pass location so active link works
function AppLayout() {
  const location = useLocation()
  // On dashboard use a more compact navbar variant
  const isDashboard = location.pathname === '/dashboard'

  return (
    <>
      <Navbar compact={isDashboard} />
      <Routes>
        <Route path="/"          element={<LandingPage />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/about"     element={<About />} />
      </Routes>
    </>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AppLayout />
    </BrowserRouter>
  )
}
