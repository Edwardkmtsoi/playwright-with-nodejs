import swaggerJsdoc from 'swagger-jsdoc';

const options = {
  definition: {
    openapi: '3.1.0',

    info: {
      title: 'Playwright Scraper API',
      version: '1.0.0',
      description:
        'Production-ready API for web scraping with Playwright and automated testing',
      contact: {
        name: 'API Support',
        url: 'https://github.com',
      },
      license: {
        name: 'MIT',
      },
    },

    servers: [
      {
        url: '/',
        description: 'Current origin',
      },
    ],

    components: {
      schemas: {
        Meta: {
          type: 'object',
          properties: {
            count: {
              type: 'integer',
            },
            durationMs: {
              type: 'integer',
            },
            targetUrl: {
              type: 'string',
            },
            timestamp: {
              type: 'string',
              format: 'date-time',
            },
          },
          required: ['durationMs', 'timestamp'],
        },

        ApiError: {
          type: 'object',
          properties: {
            success: {
              type: 'boolean',
              enum: [false],
            },
            error: {
              type: 'string',
            },
            meta: {
              $ref: '#/components/schemas/Meta',
            },
          },
        },

        HealthResponse: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['healthy', 'unhealthy'],
            },
            uptime: {
              type: 'number',
            },
            environment: {
              type: 'string',
            },
            timestamp: {
              type: 'string',
              format: 'date-time',
            },
          },
        },

        ScrapeSite: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
            },
            description: {
              type: 'string',
            },
            url: {
              type: 'string',
              format: 'uri',
            },
          },
          required: ['title', 'url'],
        },

        Product: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
            },
            price: {
              type: 'string',
            },
            description: {
              type: 'string',
            },
            rating: {
              type: 'string',
            },
            url: {
              type: 'string',
              format: 'uri',
            },
          },
        },

        RepcoProduct: {
          type: 'object',
          properties: {
            site: {
              type: 'string',
              example: 'repco',
            },
            url: {
              type: 'string',
              format: 'uri',
            },
            name: {
              type: 'string',
              nullable: true,
            },
            sku: {
              type: 'string',
              nullable: true,
            },
            price: {
              type: 'number',
              nullable: true,
              example: 115,
            },
            originalPrice: {
              type: 'number',
              nullable: true,
              example: 145,
            },
            memberPrice: {
              type: 'number',
              nullable: true,
              example: 99,
            },
            currency: {
              type: 'string',
              example: 'NZD',
            },
            availability: {
              type: 'string',
              nullable: true,
              example: 'check_availability',
            },
            scrapedAt: {
              type: 'string',
              format: 'date-time',
            },
          },
          required: [
            'site',
            'url',
            'name',
            'sku',
            'price',
            'originalPrice',
            'memberPrice',
            'currency',
            'availability',
            'scrapedAt',
          ],
        },

        SmokeTestCheck: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
            },
            passed: {
              type: 'boolean',
            },
            error: {
              type: 'string',
            },
          },
        },

        SmokeTestResult: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              enum: ['test-sites', 'ecommerce'],
            },
            passed: {
              type: 'boolean',
            },
            checks: {
              type: 'array',
              items: {
                $ref: '#/components/schemas/SmokeTestCheck',
              },
            },
            durationMs: {
              type: 'integer',
            },
            timestamp: {
              type: 'string',
              format: 'date-time',
            },
          },
        },
      },
    },
  },

  apis: [
    './src/routes/*.ts',
    './src/controllers/*.ts',
    './dist/routes/*.js',
    './dist/controllers/*.js',
  ],
};

export const swaggerSpec = swaggerJsdoc(options);
