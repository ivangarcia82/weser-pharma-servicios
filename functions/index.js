/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const { setGlobalOptions } = require("firebase-functions");
const { onRequest } = require("firebase-functions/https");
const logger = require("firebase-functions/logger");

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `maxInstances` option in the function's options, e.g.
// `onRequest({ maxInstances: 5 }, (req, res) => { ... })`.
// NOTE: setGlobalOptions does not apply to functions using the v1 API. V1
// functions should each use functions.runWith({ maxInstances: 10 }) instead.
// In the v1 API, each function can only serve one request per container, so
// this will be the maximum concurrent request count.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

// Define secrets if you plan to use Secret Manager, otherwise we fallback to process.env
// But since the user specifically mentioned .env, we'll continue using process.env access
// Note: In Gen 2, environment variables from .env files are supported if configured correctly.
// Ideally, secrets should be used for tokens.

setGlobalOptions({ maxInstances: 10 });

/**
 * Helper function to make GraphQL requests to Shopify
 * @param {string} query - The GraphQL query or mutation
 * @param {object} variables - Variables for the query
 * @returns {Promise<object>} - The data response from Shopify
 */
const shopifyRequest = async (query, variables = {}) => {
    const { SHOPIFY_TOKEN, GRAPHQL_URL } = process.env;

    if (!SHOPIFY_TOKEN || !GRAPHQL_URL) {
        throw new HttpsError("failed-precondition", "Missing Shopify credentials in environment variables.");
    }

    try {
        const response = await fetch(GRAPHQL_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": SHOPIFY_TOKEN,
            },
            body: JSON.stringify({ query, variables }),
        });

        const result = await response.json();

        if (result.errors) {
            logger.error("Shopify GraphQL Errors", result.errors);
            throw new HttpsError("internal", "Error responding from Shopify", result.errors);
        }

        return result.data;
    } catch (error) {
        logger.error("Shopify Request Failed", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Shopify request failed", error.message);
    }
};

const formatCurrency = (amount) => {
  const num = parseFloat(amount);
  return `$ ${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const nodesQuery = `
  nodes {
    id
    name
    createdAt
    totalPriceSet {
      shopMoney { amount }
    }
    lineItems(first: 50) {
      nodes {
        title
        variant { displayName selectedOptions { name value } unitPrice { amount } price }
        product { descriptionHtml }
        image { url }
      }
    }
    metafields(first: 10) {
      nodes {
        key
        value
      }
    }
  }
`;

const getOrdersObject = (nodes) => {
  return nodes.map((node) => {
    const date = node.createdAt;
    const resultDate = new Date(date);
    const cdmxDate = new Date(resultDate.toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
    const pad = n => String(n).padStart(2, '0');
    const day = pad(cdmxDate.getDate());
    const month = pad(cdmxDate.getMonth() + 1);
    const year = cdmxDate.getFullYear();
    const hours = pad(cdmxDate.getHours());
    const minutes = pad(cdmxDate.getMinutes());
    const seconds = pad(cdmxDate.getSeconds());

    const productsName = (node.lineItems?.nodes || []).map((li) => `${li.variant?.displayName}`).join('');
    const ordenCompraMetafield = (node.metafields?.nodes || []).find(
      mf => mf.key === 'orden_de_compra' || mf.key === 'orden de compra'
    );

    const modalProducts = (node.lineItems?.nodes || []).map((li) => {
      let color = '';
      let quantity = '';

      (li.variant?.selectedOptions || []).forEach(option => {
        if (option.name === 'Color') {
          color = option.value;
        } else if (option.name === 'Cantidad') {
          quantity = option.value;
        }
      });

      return {
        title: `${li.title} - ${color}`,
        description: li.product?.descriptionHtml,
        quantity,
        price: formatCurrency(li.variant?.unitPrice?.amount),
        total: formatCurrency(li.variant?.price),
        image: li.image?.url
      };
    });

    const downloadDetails = {
      date: `${day}-${month}-${year} ${hours}.${minutes}`,
      totals: [
        {
          key: "SUBTOTAL",
          value: formatCurrency(node.totalPriceSet.shopMoney.amount).replace(' ', '')
        },
        {
          key: "IVA",
          value: formatCurrency(parseFloat(node.totalPriceSet.shopMoney.amount) * 0.16).replace(' ', '')
        },
        {
          key: "TOTAL",
          value: formatCurrency(parseFloat(node.totalPriceSet.shopMoney.amount) * 1.16).replace(' ', '')
        }
      ],
      line_items: (node.lineItems?.nodes || []).map((li) => {
        let color = '';
        let quantity = '';

        (li.variant?.selectedOptions || []).forEach(option => {
          if (option.name === 'Color') {
            color = option.value;
          } else if (option.name === 'Cantidad') {
            quantity = option.value;
          }
        });

        return {
          title: `${li.title} - ${color}`,
          description: li.product?.descriptionHtml,
          quantity,
          unit_price: formatCurrency(li.variant?.unitPrice?.amount).replace(' ', ''),
          line_price: formatCurrency(li.variant?.price).replace(' ', ''),
          image: li.image?.url
        };
      })
    };

    return {
      id: node.id,
      name: node.name,
      showDate: `${day}/${month}/${year} ${hours}:${minutes}`,
      internalDate: `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`,
      productsName,
      orderStatus: ordenCompraMetafield ? 'Completada' : 'Pendiente',
      statusClass: ordenCompraMetafield ? 'completed' : 'pending',
      modalProducts,
      itemsSize: node.lineItems?.nodes?.length,
      totalPriceWithoutCurrency: node.totalPriceSet.shopMoney.amount,
      totalPriceWithCurrency: formatCurrency(node.totalPriceSet.shopMoney.amount),
      userName: (node.metafields?.nodes || []).find(mf => mf.key === 'usuario')?.value,
      downloadDetails,
    };
  });
}

/**
 * Create a Draft Order
 * Input:
 * - lineItems: Array of objects { variantId, quantity, customAttributes, etc }
 * - customerId: String (optional) - Shopify Customer ID (e.g., "gid://shopify/Customer/123456")
 * - email: String (optional)
 * - query: String (optional) - GraphQL mutation override or specific needs? (Assuming standard here)
 */
exports.createDraftOrder = onCall(async (request) => {
    const { lineItems, customerId, email, userName } = request.data;

    // Basic validation
    if (!lineItems || !Array.isArray(lineItems) || lineItems.length === 0) {
        throw new HttpsError("invalid-argument", "The function must be called with a 'lineItems' array.");
    }

    const mutation = `
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            name
            createdAt
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    // Construct input object
    const input = {
        lineItems,
        purchasingEntity: {
            customerId,
        },
        email,
        tags: [email.includes('generandoideas') ? 'generandoideas' : 'weserpharma'],
        metafields: [
            {
                key: 'usuario',
                namespace: 'custom',
                type: 'single_line_text_field',
                value: userName,
            },
        ],
    };

    const data = await shopifyRequest(mutation, { input });

    const { draftOrderCreate } = data;
    if (draftOrderCreate.userErrors && draftOrderCreate.userErrors.length > 0) {
        throw new HttpsError("invalid-argument", "Shopify validation errors", draftOrderCreate.userErrors);
    }

    return { success: true, draftOrder: draftOrderCreate.draftOrder };
});

/**
 * Get Draft Orders by User (Customer ID)
 * Input:
 * - customerId: String (e.g., "gid://shopify/Customer/123...") OR just the numeric ID if we parse it.
 * Note: The draftOrders query supports 'query' filter.
 */
exports.getDraftOrdersByUser = onCall(async (request) => {
    const { customerId } = request.data;

    if (!customerId) {
        throw new HttpsError("invalid-argument", "The function must be called with a 'customerId'.");
    }

    // Ensure customerId is in valid format if needed, but 'query' filter is flexible.
    // Shopify search query syntax for customer_id looks for numeric ID usually,
    // but if we pass GID, we might need to extract the ID.
    // Let's assume input is a clean numeric ID or we handle it.
    // If it's a GID like "gid://shopify/Customer/123", we extract "123".
    let numericId = customerId;
    if (customerId.includes("/")) {
        numericId = customerId.split("/").pop();
    }

    const query = `
      query getDraftOrders($queryString: String!) {
        draftOrders(first: 50, query: $queryString, reverse: true) {
          ${nodesQuery}
        }
      }
    `;

    const variables = { queryString: `customer_id:${numericId}` };
    const data = await shopifyRequest(query, variables);

    const orders = getOrdersObject(data?.draftOrders?.nodes);

    return { success: true, orders };
});

/**
 * Get All Draft Orders
 */
exports.getAllDraftOrders = onCall(async (request) => {
  const { customerEmail } = request.data;
  const query = `
    query getDraftOrders($queryString: String!) {
      draftOrders(first: 50, query: $queryString, reverse: true) {
        ${nodesQuery}
      }
    }
  `;

  const variables = { queryString: customerEmail.includes("generandoideas") ? "" : "tag:weserpharma" };
  const data = await shopifyRequest(query, variables);

  const orders = getOrdersObject(data?.draftOrders?.nodes);

  return { success: true, orders };
});
