---
"@narumitw/pi-usage": minor
---

Add account-wide OpenRouter credit reporting with a separately configured Management API key.

The extension now queries OpenRouter's account credits endpoint separately from the inference key endpoint, displays the account balance in the statusline and detailed report, supports negative balances, and falls back to per-key usage when account credits are unavailable.
