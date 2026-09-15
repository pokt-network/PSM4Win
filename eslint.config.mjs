import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      '**/release',
      'reference/**',
      'fixtures/**',
      'pocket-service-manager-electron/**'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  { settings: { react: { version: 'detect' } } },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules,
      // Screens export their row-action functions next to the component on purpose (docs/SCREENS.md 3.2).
      'react-refresh/only-export-components': 'off',
      // Screen texts are copied verbatim from the HTA, apostrophes included.
      'react/no-unescaped-entities': 'off',
      // Async loaders called from effects set state after their first await; keep the hint visible without failing the build.
      'react-hooks/set-state-in-effect': 'warn'
    }
  },
  eslintConfigPrettier
)
