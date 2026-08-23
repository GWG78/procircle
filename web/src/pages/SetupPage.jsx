import React from 'react'
import { Page } from '@shopify/polaris'
import BrandProfileForm from '../components/BrandProfileForm'

/**
 * First-run setup — shown instead of the main app (see App.jsx's guard)
 * until the shop's brand profile is complete. Reuses BrandProfileForm, the
 * same fields/API/intro copy as Settings, just framed as onboarding via the
 * page title. onComplete fires only once the profile is actually complete
 * (BrandProfileForm's Save is disabled until then via requireComplete) and
 * hands control back to App.jsx to drop into the main Campaigns/Settings
 * shell.
 */
export default function SetupPage({ onComplete }) {
  return (
    <Page title="Welcome to ProCircle — let's set up your brand profile">
      <BrandProfileForm submitLabel="Finish setup" requireComplete onSaveSuccess={onComplete} />
    </Page>
  )
}
