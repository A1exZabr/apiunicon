export const WB_STYLE_YAML = `openapi: 3.0.1
info:
  title: Заказы FBS
  version: orders-fbs
paths:
  /api/v3/orders/new:
    servers:
      - url: https://marketplace-api.wildberries.ru
        description: "**Prod**"
      - url: https://marketplace-api-sandbox.wildberries.ru
        description: "**Sandbox**"
    get:
      operationId: getOrdersNew
      summary: Получить список новых сборочных заданий
      parameters:
        - $ref: '#/components/parameters/Limit'
      responses:
        '200':
          description: Успешно
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/OrdersNew'
        '401':
          $ref: '#/components/responses/401'
components:
  securitySchemes:
    HeaderApiKey:
      type: apiKey
      name: Authorization
      in: header
  parameters:
    Limit:
      name: limit
      in: query
      required: true
      schema:
        type: integer
        maximum: 1000
  responses:
    '401':
      description: Пользователь не авторизован
  schemas:
    OrdersNew:
      type: object
      properties:
        orders:
          type: array
          items:
            type: object
            properties:
              id:
                type: integer
`;
