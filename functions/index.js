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

/**
 * Create a Draft Order
 * Input:
 * - lineItems: Array of objects { variantId, quantity, customAttributes, etc }
 * - customerId: String (optional) - Shopify Customer ID (e.g., "gid://shopify/Customer/123456")
 * - email: String (optional)
 * - query: String (optional) - GraphQL mutation override or specific needs? (Assuming standard here)
 */
exports.createDraftOrder = onCall(async (request) => {
    const { lineItems, customerId, email, shippingAddress, note, useAllDiscountIndicator } = request.data;

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
          invoiceUrl
          totalPrice
          currencyCode
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
        lineItems: lineItems, // Ensure these match DraftOrderLineItemInput
        note: note,
    };

    if (customerId) input.customerId = customerId;
    if (email) input.email = email;
    if (shippingAddress) input.shippingAddress = shippingAddress;
    if (useAllDiscountIndicator) input.useCustomerDefaultAddress = true; // Example flag

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
      draftOrders(first: 20, query: $queryString, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            totalPrice
            status
            customer {
              firstName
              lastName
              email
            }
          }
        }
      }
    }
  `;

    // Search query: "customer_id:123456"
    const variables = { queryString: `customer_id:${numericId}` };

    const data = await shopifyRequest(query, variables);

    // Flatten edges/nodes for easier client consumption
    const orders = data.draftOrders.edges.map(edge => edge.node);

    return { success: true, orders };
});

/**
 * Get All Draft Orders
 * Input:
 * - limit: Number (default 10)
 * - cursor: String (optional) - for pagination
 */
exports.getAllDraftOrders = onCall(async (request) => {
    const limit = request.data.limit || 10;
    const cursor = request.data.cursor || null;

    const query = `
    query getAllDraftOrders($first: Int!, $after: String) {
      draftOrders(first: $first, after: $after, reverse: true) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            name
            email
            createdAt
            totalPrice
            status
            customer {
              displayName
            }
          }
        }
      }
    }
  `;

    const variables = { first: limit, after: cursor };
    const data = await shopifyRequest(query, variables);

    return {
        success: true,
        orders: data.draftOrders.edges.map(edge => edge.node),
        pageInfo: data.draftOrders.pageInfo
    };
});
