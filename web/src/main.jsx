import React from 'react'
import ReactDOM from 'react-dom/client'
import { AppProvider } from '@shopify/polaris'
import enTranslations from '@shopify/polaris/locales/en.json'
import '@shopify/polaris/build/esm/styles.css'
import App from './App'

const params = new URLSearchParams(window.location.search)
const host = params.get('host') || ''

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppProvider i18n={enTranslations}>
      <App host={host} />
    </AppProvider>
  </React.StrictMode>
)
