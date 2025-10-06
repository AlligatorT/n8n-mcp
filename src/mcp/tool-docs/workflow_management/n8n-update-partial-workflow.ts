import { ToolDocumentation } from '../types';

export const n8nUpdatePartialWorkflowDoc: ToolDocumentation = {
  name: 'n8n_update_partial_workflow',
  category: 'workflow_management',
  essentials: {
    description: 'Update workflow incrementally with diff operations. Types: addNode, removeNode, updateNode, moveNode, enable/disableNode, addConnection, removeConnection, rewireConnection, cleanStaleConnections, replaceConnections, updateSettings, updateName, add/removeTag. Supports smart parameters (branch, case) for multi-output nodes. Full support for AI connections (ai_languageModel, ai_tool, ai_memory, ai_embedding, ai_vectorStore, ai_document, ai_textSplitter, ai_outputParser).',
    keyParameters: ['id', 'operations', 'continueOnError'],
    example: 'n8n_update_partial_workflow({id: "wf_123", operations: [{type: "rewireConnection", source: "IF", from: "Old", to: "New", branch: "true"}]})',
    performance: 'Fast (50-200ms)',
    tips: [
      'Use rewireConnection to change connection targets',
      'Use branch="true"/"false" for IF nodes',
      'Use case=N for Switch nodes',
      'Use cleanStaleConnections to auto-remove broken connections',
      'Set ignoreErrors:true on removeConnection for cleanup',
      'Use continueOnError mode for best-effort bulk operations',
      'Validate with validateOnly first',
      'For AI connections, specify sourceOutput type (ai_languageModel, ai_tool, etc.)',
      'Batch AI component connections for atomic updates'
    ]
  },
  full: {
    description: `Updates workflows using surgical diff operations instead of full replacement. Supports 15 operation types for precise modifications. Operations are validated and applied atomically by default - all succeed or none are applied.

## Available Operations:

### Node Operations (6 types):
- **addNode**: Add a new node with name, type, and position (required)
- **removeNode**: Remove a node by ID or name
- **updateNode**: Update node properties using dot notation (e.g., 'parameters.url')
- **moveNode**: Change node position [x, y]
- **enableNode**: Enable a disabled node
- **disableNode**: Disable an active node

### Connection Operations (5 types):
- **addConnection**: Connect nodes (source→target). Supports smart parameters: branch="true"/"false" for IF nodes, case=N for Switch nodes.
- **removeConnection**: Remove connection between nodes (supports ignoreErrors flag)
- **rewireConnection**: Change connection target from one node to another. Supports smart parameters.
- **cleanStaleConnections**: Auto-remove all connections referencing non-existent nodes
- **replaceConnections**: Replace entire connections object

### Metadata Operations (4 types):
- **updateSettings**: Modify workflow settings
- **updateName**: Rename the workflow
- **addTag**: Add a workflow tag
- **removeTag**: Remove a workflow tag

## Smart Parameters for Multi-Output Nodes

For **IF nodes**, use semantic 'branch' parameter instead of technical sourceIndex:
- **branch="true"**: Routes to true branch (sourceIndex=0)
- **branch="false"**: Routes to false branch (sourceIndex=1)

For **Switch nodes**, use semantic 'case' parameter:
- **case=0**: First output
- **case=1**: Second output
- **case=N**: Nth output

Works with addConnection and rewireConnection operations. Explicit sourceIndex overrides smart parameters.

## AI Connection Support

Full support for all 8 AI connection types used in n8n AI workflows:

**Connection Types**:
- **ai_languageModel**: Connect language models (OpenAI, Anthropic, Google Gemini) to AI Agents
- **ai_tool**: Connect tools (HTTP Request Tool, Code Tool, etc.) to AI Agents
- **ai_memory**: Connect memory systems (Window Buffer, Conversation Summary) to AI Agents
- **ai_outputParser**: Connect output parsers (Structured, JSON) to AI Agents
- **ai_embedding**: Connect embedding models to Vector Stores
- **ai_vectorStore**: Connect vector stores to Vector Store Tools
- **ai_document**: Connect document loaders to Vector Stores
- **ai_textSplitter**: Connect text splitters to document processing chains

**AI Connection Examples**:
- Single connection: \`{type: "addConnection", source: "OpenAI", target: "AI Agent", sourceOutput: "ai_languageModel"}\`
- Fallback model: Use targetIndex (0=primary, 1=fallback) for dual language model setup
- Multiple tools: Batch multiple \`sourceOutput: "ai_tool"\` connections to one AI Agent
- Vector retrieval: Chain ai_embedding → ai_vectorStore → ai_tool → AI Agent

**Best Practices**:
- Always specify \`sourceOutput\` for AI connections (defaults to "main" if omitted)
- Connect language model BEFORE creating/enabling AI Agent (validation requirement)
- Use atomic mode (default) when setting up AI workflows to ensure complete configuration
- Validate AI workflows after changes with \`n8n_validate_workflow\` tool

## Cleanup & Recovery Features

### Automatic Cleanup
The **cleanStaleConnections** operation automatically removes broken connection references after node renames/deletions. Essential for workflow recovery.

### Best-Effort Mode
Set **continueOnError: true** to apply valid operations even if some fail. Returns detailed results showing which operations succeeded/failed. Perfect for bulk cleanup operations.

### Graceful Error Handling
Add **ignoreErrors: true** to removeConnection operations to prevent failures when connections don't exist.`,
    parameters: {
      id: { type: 'string', required: true, description: 'Workflow ID to update' },
      operations: {
        type: 'array',
        required: true,
        description: 'Array of diff operations. Each must have "type" field and operation-specific properties. Nodes can be referenced by ID or name.'
      },
      validateOnly: { type: 'boolean', description: 'If true, only validate operations without applying them' },
      continueOnError: { type: 'boolean', description: 'If true, apply valid operations even if some fail (best-effort mode). Returns applied and failed operation indices. Default: false (atomic)' }
    },
    returns: 'Updated workflow object or validation results if validateOnly=true',
    examples: [
      '// Add a basic node (minimal configuration)\nn8n_update_partial_workflow({id: "abc", operations: [{type: "addNode", node: {name: "Process Data", type: "n8n-nodes-base.set", position: [400, 300], parameters: {}}}]})',
      '// Add node with full configuration\nn8n_update_partial_workflow({id: "def", operations: [{type: "addNode", node: {name: "Send Slack Alert", type: "n8n-nodes-base.slack", position: [600, 300], typeVersion: 2, parameters: {resource: "message", operation: "post", channel: "#alerts", text: "Success!"}}}]})',
      '// Add node AND connect it (common pattern)\nn8n_update_partial_workflow({id: "ghi", operations: [\n  {type: "addNode", node: {name: "HTTP Request", type: "n8n-nodes-base.httpRequest", position: [400, 300], parameters: {url: "https://api.example.com", method: "GET"}}},\n  {type: "addConnection", source: "Webhook", target: "HTTP Request"}\n]})',
      '// Rewire connection from one target to another\nn8n_update_partial_workflow({id: "xyz", operations: [{type: "rewireConnection", source: "Webhook", from: "Old Handler", to: "New Handler"}]})',
      '// Smart parameter: IF node true branch\nn8n_update_partial_workflow({id: "abc", operations: [{type: "addConnection", source: "IF", target: "Success Handler", branch: "true"}]})',
      '// Smart parameter: IF node false branch\nn8n_update_partial_workflow({id: "def", operations: [{type: "addConnection", source: "IF", target: "Error Handler", branch: "false"}]})',
      '// Smart parameter: Switch node case routing\nn8n_update_partial_workflow({id: "ghi", operations: [\n  {type: "addConnection", source: "Switch", target: "Handler A", case: 0},\n  {type: "addConnection", source: "Switch", target: "Handler B", case: 1},\n  {type: "addConnection", source: "Switch", target: "Handler C", case: 2}\n]})',
      '// Rewire with smart parameter\nn8n_update_partial_workflow({id: "jkl", operations: [{type: "rewireConnection", source: "IF", from: "Old True Handler", to: "New True Handler", branch: "true"}]})',
      '// Add multiple nodes in batch\nn8n_update_partial_workflow({id: "mno", operations: [\n  {type: "addNode", node: {name: "Filter", type: "n8n-nodes-base.filter", position: [400, 300], parameters: {}}},\n  {type: "addNode", node: {name: "Transform", type: "n8n-nodes-base.set", position: [600, 300], parameters: {}}},\n  {type: "addConnection", source: "Filter", target: "Transform"}\n]})',
      '// Clean up stale connections after node renames/deletions\nn8n_update_partial_workflow({id: "pqr", operations: [{type: "cleanStaleConnections"}]})',
      '// Remove connection gracefully (no error if it doesn\'t exist)\nn8n_update_partial_workflow({id: "stu", operations: [{type: "removeConnection", source: "Old Node", target: "Target", ignoreErrors: true}]})',
      '// Best-effort mode: apply what works, report what fails\nn8n_update_partial_workflow({id: "vwx", operations: [\n  {type: "updateName", name: "Fixed Workflow"},\n  {type: "removeConnection", source: "Broken", target: "Node"},\n  {type: "cleanStaleConnections"}\n], continueOnError: true})',
      '// Update node parameter\nn8n_update_partial_workflow({id: "yza", operations: [{type: "updateNode", nodeName: "HTTP Request", updates: {"parameters.url": "https://api.example.com"}}]})',
      '// Validate before applying\nn8n_update_partial_workflow({id: "bcd", operations: [{type: "removeNode", nodeName: "Old Process"}], validateOnly: true})',
      '\n// ============ AI CONNECTION EXAMPLES ============',
      '// Connect language model to AI Agent\nn8n_update_partial_workflow({id: "ai1", operations: [{type: "addConnection", source: "OpenAI Chat Model", target: "AI Agent", sourceOutput: "ai_languageModel"}]})',
      '// Connect tool to AI Agent\nn8n_update_partial_workflow({id: "ai2", operations: [{type: "addConnection", source: "HTTP Request Tool", target: "AI Agent", sourceOutput: "ai_tool"}]})',
      '// Connect memory to AI Agent\nn8n_update_partial_workflow({id: "ai3", operations: [{type: "addConnection", source: "Window Buffer Memory", target: "AI Agent", sourceOutput: "ai_memory"}]})',
      '// Connect output parser to AI Agent\nn8n_update_partial_workflow({id: "ai4", operations: [{type: "addConnection", source: "Structured Output Parser", target: "AI Agent", sourceOutput: "ai_outputParser"}]})',
      '// Complete AI Agent setup: Add language model, tools, and memory\nn8n_update_partial_workflow({id: "ai5", operations: [\n  {type: "addConnection", source: "OpenAI Chat Model", target: "AI Agent", sourceOutput: "ai_languageModel"},\n  {type: "addConnection", source: "HTTP Request Tool", target: "AI Agent", sourceOutput: "ai_tool"},\n  {type: "addConnection", source: "Code Tool", target: "AI Agent", sourceOutput: "ai_tool"},\n  {type: "addConnection", source: "Window Buffer Memory", target: "AI Agent", sourceOutput: "ai_memory"}\n]})',
      '// Add fallback model to AI Agent (requires v2.1+)\nn8n_update_partial_workflow({id: "ai6", operations: [\n  {type: "addConnection", source: "OpenAI Chat Model", target: "AI Agent", sourceOutput: "ai_languageModel", targetIndex: 0},\n  {type: "addConnection", source: "Anthropic Chat Model", target: "AI Agent", sourceOutput: "ai_languageModel", targetIndex: 1}\n]})',
      '// Vector Store setup: Connect embeddings and documents\nn8n_update_partial_workflow({id: "ai7", operations: [\n  {type: "addConnection", source: "Embeddings OpenAI", target: "Pinecone Vector Store", sourceOutput: "ai_embedding"},\n  {type: "addConnection", source: "Default Data Loader", target: "Pinecone Vector Store", sourceOutput: "ai_document"}\n]})',
      '// Connect Vector Store Tool to AI Agent (retrieval setup)\nn8n_update_partial_workflow({id: "ai8", operations: [\n  {type: "addConnection", source: "Pinecone Vector Store", target: "Vector Store Tool", sourceOutput: "ai_vectorStore"},\n  {type: "addConnection", source: "Vector Store Tool", target: "AI Agent", sourceOutput: "ai_tool"}\n]})',
      '// Rewire AI Agent to use different language model\nn8n_update_partial_workflow({id: "ai9", operations: [{type: "rewireConnection", source: "AI Agent", from: "OpenAI Chat Model", to: "Anthropic Chat Model", sourceOutput: "ai_languageModel"}]})',
      '// Replace all AI tools for an agent\nn8n_update_partial_workflow({id: "ai10", operations: [\n  {type: "removeConnection", source: "Old Tool 1", target: "AI Agent", sourceOutput: "ai_tool"},\n  {type: "removeConnection", source: "Old Tool 2", target: "AI Agent", sourceOutput: "ai_tool"},\n  {type: "addConnection", source: "New HTTP Tool", target: "AI Agent", sourceOutput: "ai_tool"},\n  {type: "addConnection", source: "New Code Tool", target: "AI Agent", sourceOutput: "ai_tool"}\n]})'
    ],
    useCases: [
      'Rewire connections when replacing nodes',
      'Route IF/Switch node outputs with semantic parameters',
      'Clean up broken workflows after node renames/deletions',
      'Bulk connection cleanup with best-effort mode',
      'Update single node parameters',
      'Replace all connections at once',
      'Graceful cleanup operations that don\'t fail',
      'Enable/disable nodes',
      'Rename workflows or nodes',
      'Manage tags efficiently',
      'Connect AI components (language models, tools, memory, parsers)',
      'Set up AI Agent workflows with multiple tools',
      'Add fallback language models to AI Agents',
      'Configure Vector Store retrieval systems',
      'Swap language models in existing AI workflows',
      'Batch-update AI tool connections'
    ],
    performance: 'Very fast - typically 50-200ms. Much faster than full updates as only changes are processed.',
    bestPractices: [
      'Use rewireConnection instead of remove+add for changing targets',
      'Use branch="true"/"false" for IF nodes instead of sourceIndex',
      'Use case=N for Switch nodes instead of sourceIndex',
      'Use cleanStaleConnections after renaming/removing nodes',
      'Use continueOnError for bulk cleanup operations',
      'Set ignoreErrors:true on removeConnection for graceful cleanup',
      'Use validateOnly to test operations before applying',
      'Group related changes in one call',
      'Check operation order for dependencies',
      'Use atomic mode (default) for critical updates',
      'For AI connections, always specify sourceOutput (ai_languageModel, ai_tool, ai_memory, etc.)',
      'Connect language model BEFORE adding AI Agent to ensure validation passes',
      'Use targetIndex for fallback models (primary=0, fallback=1)',
      'Batch AI component connections in a single operation for atomicity',
      'Validate AI workflows after connection changes to catch configuration errors'
    ],
    pitfalls: [
      '**REQUIRES N8N_API_URL and N8N_API_KEY environment variables** - will not work without n8n API access',
      'Atomic mode (default): all operations must succeed or none are applied',
      'continueOnError breaks atomic guarantees - use with caution',
      'Order matters for dependent operations (e.g., must add node before connecting to it)',
      'Node references accept ID or name, but name must be unique',
      'Node names with special characters (apostrophes, quotes) work correctly',
      'For best compatibility, prefer node IDs over names when dealing with special characters',
      'Use "updates" property for updateNode operations: {type: "updateNode", updates: {...}}',
      'Smart parameters (branch, case) only work with IF and Switch nodes - ignored for other node types',
      'Explicit sourceIndex overrides smart parameters (branch, case) if both provided',
      'cleanStaleConnections removes ALL broken connections - cannot be selective',
      'replaceConnections overwrites entire connections object - all previous connections lost'
    ],
    relatedTools: ['n8n_update_full_workflow', 'n8n_get_workflow', 'validate_workflow', 'tools_documentation']
  }
};