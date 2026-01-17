# Console API Documentation

This document describes how to use the Mako Console API to execute saved consoles remotely.

## API Endpoints

The API is available at: `/api/workspaces/{workspaceId}/consoles`

## Authentication

All API requests require authentication using an API key. You can create and manage API keys in the workspace settings.

Include your API key in the `Authorization` header:

```
Authorization: Bearer revops_YOUR_API_KEY_HERE
```

## Endpoints

### List All Consoles

Get a list of all consoles in the workspace.

**Endpoint:** `GET /api/workspaces/{workspaceId}/consoles/list`

**Response:**

```json
{
  "success": true,
  "consoles": [
    {
      "id": "console_id",
      "name": "Console Name",
      "description": "Console description",
      "language": "sql",
      "database": {
        "id": "database_id",
        "name": "Database Name",
        "type": "postgresql"
      },
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-01-01T00:00:00Z",
      "lastExecutedAt": "2024-01-01T00:00:00Z",
      "executionCount": 10
    }
  ],
  "total": 1
}
```

### Get Console Details

Get detailed information about a specific console, including its code.

**Endpoint:** `GET /api/workspaces/{workspaceId}/consoles/{consoleId}/details`

**Response:**

```json
{
  "success": true,
  "console": {
    "id": "console_id",
    "name": "Console Name",
    "description": "Console description",
    "code": "SELECT * FROM users LIMIT 10;",
    "language": "sql",
    "mongoOptions": null,
    "database": {
      "id": "database_id",
      "name": "Database Name",
      "type": "postgresql"
    },
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z",
    "lastExecutedAt": "2024-01-01T00:00:00Z",
    "executionCount": 10
  }
}
```

### Execute Console

Execute a saved console and get the results.

**Endpoint:** `POST /api/workspaces/{workspaceId}/consoles/{consoleId}/execute`

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "John Doe",
      "email": "john@example.com"
    },
    {
      "id": 2,
      "name": "Jane Smith",
      "email": "jane@example.com"
    }
  ],
  "rowCount": 2,
  "fields": [...],
  "console": {
    "id": "console_id",
    "name": "Console Name",
    "language": "sql",
    "executedAt": "2024-01-01T00:00:00Z"
  }
}
```

## Error Responses

All error responses follow this format:

```json
{
  "success": false,
  "error": "Error message description"
}
```

Common error codes:

- `401 Unauthorized` - Invalid or missing API key
- `404 Not Found` - Console or database not found
- `400 Bad Request` - Invalid request parameters
- `500 Internal Server Error` - Server error during execution

## Example Usage

### cURL Example

```bash
# List all consoles
curl -H "Authorization: Bearer revops_YOUR_API_KEY" \
  https://your-mako-instance.com/api/workspaces/WORKSPACE_ID/consoles/list

# Execute a console
curl -X POST \
  -H "Authorization: Bearer revops_YOUR_API_KEY" \
  https://your-mako-instance.com/api/workspaces/WORKSPACE_ID/consoles/CONSOLE_ID/execute
```

### JavaScript Example

```javascript
const API_KEY = "revops_YOUR_API_KEY";
const WORKSPACE_ID = "your_workspace_id";
const CONSOLE_ID = "your_console_id";

// Execute a console
async function executeConsole() {
  const response = await fetch(
    `https://your-mako-instance.com/api/workspaces/${WORKSPACE_ID}/consoles/${CONSOLE_ID}/execute`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
      },
    },
  );

  const result = await response.json();
  console.log(result);
}
```

### Python Example

```python
import requests

API_KEY = 'revops_YOUR_API_KEY'
WORKSPACE_ID = 'your_workspace_id'
CONSOLE_ID = 'your_console_id'

# Execute a console
response = requests.post(
    f'https://your-mako-instance.com/api/workspaces/{WORKSPACE_ID}/consoles/{CONSOLE_ID}/execute',
    headers={
        'Authorization': f'Bearer {API_KEY}'
    }
)

result = response.json()
print(result)
```

## Rate Limiting

Currently, there are no rate limits on API requests. This may change in the future.

## Security Notes

- API keys are hashed and stored securely
- Each API key is tied to a specific workspace
- API keys have the same permissions as the user who created them
- Store your API keys securely and never commit them to version control
- Regenerate API keys if they are compromised
