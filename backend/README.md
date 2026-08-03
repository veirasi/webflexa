# Backend de Roteamento (WebFlexa)

Este backend cria o endpoint de produção:

- `POST /estimate-route`

Ele:
- valida acesso multi-tenant (`tenantId`)
- busca o ponto A do lojista em `usuarios/{tenantId}/endereco`
- geocodifica origem/destino com Nominatim
- calcula rota com OSRM
- retorna `{ distanciaKm, duracaoMin }`

## Pré-requisitos

- Firebase CLI instalada
- Projeto Firebase com Realtime Database habilitado
- Usuários autenticando com Firebase Auth (ID token)

## Deploy

1. Entre na pasta backend:

```bash
cd backend
```

2. Instale dependências:

```bash
cd functions
npm install
cd ..
```

3. (Opcional) Variáveis de ambiente:

- `REQUIRE_AUTH=true` (padrão)
- `CORS_ORIGIN=https://seu-dominio.com`
- `ROUTING_REGION=southamerica-east1`

4. Deploy:

```bash
firebase deploy --only functions:routing
```

## URL final

Depois do deploy, a base será algo como:

- `https://southamerica-east1-flexa-app-41205.cloudfunctions.net/routing`

Endpoint completo:

- `https://southamerica-east1-flexa-app-41205.cloudfunctions.net/routing/estimate-route`

## Contrato esperado

Request:

```json
{
  "tenantId": "UID_DO_LOJISTA",
  "tenantType": "lojista",
  "origemEndereco": "opcional",
  "destinoEndereco": "Rua X, 123 - Cidade/UF"
}
```

Response:

```json
{
  "tenantId": "UID_DO_LOJISTA",
  "tenantType": "lojista",
  "origemEndereco": "Rua da loja...",
  "destinoEndereco": "Rua do destinatario...",
  "distanciaKm": 8.42,
  "duracaoMin": 21
}
```

## Frontend

No frontend, configure:

```js
window.FLEXA_ROUTING_PROXY_URL = 'https://southamerica-east1-flexa-app-41205.cloudfunctions.net/routing';
```

