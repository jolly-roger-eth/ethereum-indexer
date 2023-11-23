---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: "ethereum-indexer"
  # text: "In-Browser Indexer"
  tagline: "A modular indexer system for ethereum and other blockchain following the same RPC standard (EIP-1193)."
  image:
    dark: /icon-white.svg
    light: /icon.svg
    width: 512
    height: 512
    alt: Logo
  actions:
    - theme: brand
      text: Guide
      link: /guide/getting-started/
    - theme: alt
      text: API
      link: /api/

features:
  - title: Can run in the browser
    details: Zero backend required, Keep your Dapp fully decentralised
  - title: Type Safe Pure Function Transform
    details: The indexer index from contract logs with type-safe input and output
  - title: State Cache and Log Cache
    details: Can resume index from past state and/or from log stream
---

