# BANSOU-action Release Checklist

## Preflight

- [ ] `npm ci`
- [ ] `npm run build`
- [ ] `dist/index.js` が更新されている
- [ ] `action.yml` の inputs と README の説明が一致している

## Release

- [ ] `v1` タグ運用ポリシーを確認
- [ ] `vX.Y.Z` タグを作成して push
- [ ] 必要に応じて `v1` タグを最新安定版へ付け替え

## Post-release

- [ ] 検証用 repo で `uses: Utsugi0101/bansou-action@v1` が解決できること
- [ ] gate mode / jwt mode の最小E2Eを確認
