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

---

# Backend de Pagamentos (Mercado Pago Pix)

Segundo endpoint de produção, no mesmo projeto:

- `POST /create-pix`
- `POST /check-pix`

O access token do Mercado Pago fica **só no servidor** (Secret Manager), nunca no navegador. O valor cobrado é sempre recalculado no servidor a partir dos envios persistidos em `usuarios/{tenantId}/pacotes` — o total enviado pelo cliente nunca é usado diretamente.

## Configurar o segredo (uma vez, antes do primeiro deploy)

```bash
firebase functions:secrets:set MP_ACCESS_TOKEN
```

Cole o *access token* do Mercado Pago quando o terminal pedir (começa com `TEST-` em ambiente de teste, ou `APP_USR-`/outro prefixo em produção). O valor fica guardado no Secret Manager do Google Cloud, nunca no código-fonte.

## Deploy

```bash
cd backend
firebase deploy --only functions:payments
```

## URL final

- `https://southamerica-east1-flexa-app-41205.cloudfunctions.net/payments`

## Contrato esperado

### `POST /create-pix`

Request (cabeçalho `Authorization: Bearer <ID_TOKEN_FIREBASE>`):

```json
{
  "tenantId": "UID_DO_LOJISTA",
  "rotaId": "rota-123",
  "envioIds": ["envio-1", "envio-2"]
}
```

Response:

```json
{
  "paymentId": "123456789",
  "status": "pending",
  "pixCode": "000201...",
  "ticketUrl": "https://...",
  "qrCodeBase64": "...",
  "totalFrete": 34.00,
  "ambiente": "teste"
}
```

### `POST /check-pix`

Request:

```json
{ "tenantId": "UID_DO_LOJISTA", "paymentId": "123456789" }
```

Response:

```json
{ "paymentId": "123456789", "status": "approved", "statusDetail": "accredited", "ambiente": "teste" }
```

## Frontend

No frontend, configure:

```js
window.FLEXA_PAYMENTS_PROXY_URL = 'https://southamerica-east1-flexa-app-41205.cloudfunctions.net/payments';
```

