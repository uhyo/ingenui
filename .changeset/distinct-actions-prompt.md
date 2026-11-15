---
"ingenui": patch
---

`formatGenUiPrompt` now tells the model that a fired action reports only its name, so every distinct choice needs its own action (e.g. `actions.addToCartBlueMug` / `actions.addToCartRedMug` instead of `actions.addToCart` on every item).
