# Tool Usage & Project Rules

- NEVER call unavailable tools like 'fetch', 'execute', 'run', 'files', or 'explore'.
- Always use 'bash' for executing shell commands or checking directory structure.
- Always use 'glob' for finding files.
- Always use 'read' to read file contents (must specify a valid filePath).
- NEVER search inside or scan 'node_modules'. Exclude 'node_modules' from all file scans.
- Always talk in Japanese.
- When modifying existing files, always prefer using the 'edit' tool (SEARCH/REPLACE blocks) over rewriting the entire file with 'write'.
- Keep SEARCH blocks short, exact, and include sufficient unique surrounding context lines.
- NEVER output raw source code directly in chat responses. Always use the 'write' or 'edit' tools to modify files.
- Do not explain. Output only the code differential blocks in Search/Replace format.
