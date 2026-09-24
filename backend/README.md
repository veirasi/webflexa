# Backend de Roteamento (WebFlexa)

Este backend cria o endpoint de produção:

- `POST /estimate-route`

Ele:
- valida acesso multi-tenant (`tenantId`)
- busca o ponto A do lojista em `usuarios/{tenantId}/endereco`
- geocodifica origem/destino com a Google Geocoding API
- calcula rota com a Google Distance Matrix API
- retorna `{ distanciaKm, duracaoMin }`

(Nota: hoje o frontend não chama este endpoint — usa sua própria rotina de
rota no navegador. Este endpoint fica pronto/mantido, mas não é dependência
do fluxo em produção enquanto isso não mudar.)

## Pré-requisitos

- Firebase CLI instalada
- Projeto Firebase com Realtime Database habilitado
- Usuários autenticando com Firebase Auth (ID token)
- Plano Blaze habilitado no projeto (Secret Manager + Cloud Functions 2ª geração exigem isso)

## Configurar o segredo da chave do Google Maps (uma vez, antes do primeiro deploy)

```bash
firebase functions:secrets:set GOOGLE_MAPS_SERVER_KEY
```

Cole a chave de API do Google Maps **do servidor** (Geocoding + Distance
Matrix habilitadas, sem restrição de referrer HTTP — essa é a chave de
servidor, diferente da `FLEXA_GOOGLE_MAPS_KEY` usada no navegador). Nunca
cole essa chave direto no código-fonte — só via este comando, direto no seu
terminal.

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

3. Variáveis de ambiente:

- `REQUIRE_AUTH=true` (padrão)
- `CORS_ORIGIN=https://seu-dominio.com,http://localhost:5501` — lista de origens permitidas separadas por vírgula. **Sem essa variável configurada, nenhuma origem é liberada** (antes o padrão era `'*'`, liberando qualquer site — travado antes do lançamento comercial). Configure com o domínio real de produção assim que ele existir.
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

`CORS_ORIGIN` (ver seção do endpoint de roteamento acima) é compartilhada
por ambas as funções — configure uma vez, vale para as duas.

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

