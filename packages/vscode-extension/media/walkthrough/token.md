## Previews need a Figma token

In Figma, go to **Settings → Security → Personal access tokens**. Create a token with these read-only scopes:

- `file_content:read`
- `file_metadata:read`

FigBridge stores it in VS Code's secret storage. It is never written to your repository.

**Rate limits:** files on a Figma Starter plan get only a few render requests a month. FigBridge batches renders and offers **Render All Previews** for those files.
