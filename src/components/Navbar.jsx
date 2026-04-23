import { Link, useLocation } from 'react-router-dom'
import './Navbar.css'

export default function Navbar({ compact = false }) {
  const location = useLocation()
  const isDashboard = location.pathname === '/dashboard'

  return (
    <nav className={`navbar${compact || isDashboard ? ' navbar-dashboard' : ''}`}>
      <div className="navbar-inner">
        <Link to="/" className="navbar-brand">
          <span className="navbar-logo">
            <span className="material-icons-round">route</span>
          </span>
          <span className="navbar-title">SmartFlow</span>
        </Link>

        <div className="navbar-links">
          <Link to="/" className={`navbar-link${location.pathname === '/' ? ' active' : ''}`}>
            Home
          </Link>
          <Link to="/dashboard" className={`navbar-link${location.pathname === '/dashboard' ? ' active' : ''}`}>
            Dashboard
          </Link>
          <Link to="/about" className={`navbar-link${location.pathname === '/about' ? ' active' : ''}`}>
            About
          </Link>
        </div>

        {/* Only show CTA when NOT on dashboard */}
        {!isDashboard && (
          <Link to="/dashboard" className="navbar-cta">
            <span className="material-icons-round">bolt</span>
            Open Dashboard
          </Link>
        )}

        {/* On dashboard: show a compact status badge instead */}
        {isDashboard && (
          <span className="navbar-status">
            <span className="navbar-status-dot" />
            AI Engine Live
          </span>
        )}
      </div>
    </nav>
  )
}
