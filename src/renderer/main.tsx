import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// Brand typefaces, bundled as local woff2 (offline app, no CDN). Imported
// before globals.css so the @font-face rules exist when the tokens use them.
import '@fontsource-variable/inter-tight/wght.css'
import '@fontsource-variable/inter-tight/wght-italic.css'
import '@fontsource-variable/stix-two-text/wght.css'
import '@fontsource-variable/stix-two-text/wght-italic.css'
import '@fontsource-variable/jetbrains-mono/wght.css'
import './styles/globals.css'
import './styles/editor.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
