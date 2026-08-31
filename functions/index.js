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
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");

// Define secrets if you plan to use Secret Manager, otherwise we fallback to process.env
// But since the user specifically mentioned .env, we'll continue using process.env access
// Note: In Gen 2, environment variables from .env files are supported if configured correctly.
// Ideally, secrets should be used for tokens.

setGlobalOptions({ maxInstances: 10 });

const { Resend } = require('resend');
const Busboy = require('busboy');
const axios = require('axios');
const FormData = require('form-data');

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

const formatDate = (date) => {
  const resultDate = new Date(date);
  const cdmxDate = new Date(resultDate.toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
  const pad = n => String(n).padStart(2, '0');
  return {
    day: pad(cdmxDate.getDate()),
    month: pad(cdmxDate.getMonth() + 1),
    year: cdmxDate.getFullYear(),
    hours: pad(cdmxDate.getHours()),
    minutes: pad(cdmxDate.getMinutes()),
    seconds: pad(cdmxDate.getSeconds())
  };
};

const calculateBusinessDays = (startDate, businessDays) => {
  const date = new Date(startDate);
  let daysAdded = 0;

  while (daysAdded < businessDays) {
    date.setDate(date.getDate() + 1);
    // Skip weekends (Saturday = 6, Sunday = 0)
    if (date.getDay() !== 6 && date.getDay() !== 0) {
      daysAdded++;
    }
  }

  return date;
};

const nodesQuery = `
  nodes {
    id
    name
    createdAt
    updatedAt
    totalPriceSet {
      shopMoney { amount }
    }
    lineItems(first: 50) {
      nodes {
        title
        variant { displayName selectedOptions { name value } unitPrice { amount } price }
        product { descriptionHtml }
        sku
        vendor
        image { url }
      }
    }
    metafields(first: 10) {
      nodes {
        key
        value
        reference {
            ... on GenericFile {
                url
            }
        }
      }
    }
  }
`;

const vendorsInfo = {
  'PromoOpcion': {
    recipients: [
      'ventascdmx3@promoopcion.com',
      'ventascdmx5@promoopcion.com',
      'jefaturacomercial@promoopcion.com',
    ],
    days: 5
  },
  'G4': {
    recipients: [
      'ventas11@g4mexico.com.mx',
      'asesor3@g4mexico.com.mx'
    ],
    days: 5
  },
  'For Promo': {
    recipients: [
      'atencionaclientes6@forpromotional.com.mx',
      'asesor5@forpromotional.com.mx'
    ],
    days: 5
  },
  'CDO': {
    recipients: [
      // 'nancy.cabrera@stocksur.com',
      // 'jacqueline.estrella@stocksur.com',
      // 'maria@stocksur.com',
      // 'alezly.vega@stocksur.com'
      'ventasxl@stocksur.com',
    ],
    days: 3
  },
  'Innova': {
    recipients: [
      'citlalli.arriaga@innovation.com.mx',
      'mariel.silva@innovation.com.mx'
    ],
    days: 5
  },
  'Doble Vela': {
    recipients: [
      'ventas12@doblevela.com',
      'ventas21@doblevela.com'
    ],
    days: 5
  },
  'Impressline': {
    recipients: [
      'df2@impressline.com.mx',
      'df3@impressline.com.mx'
    ],
    days: 5
  },
  'IUSB': {
    recipients: [
      'amaciel@iupromo.mx',
      'barevalo@iupromo.mx'
    ],
    days: 5
  },
}

const getOrdersObject = (nodes) => {
  return nodes.map((node) => {
    const date = formatDate(node.createdAt);
    const updatedAt = formatDate(node.updatedAt);

    const productsName = (node.lineItems?.nodes || []).map((li) => `${li.variant?.displayName}`).join('');
    const ordenCompraMetafield = (node.metafields?.nodes || []).find(
      mf => mf.key === 'orden_de_compra'
    );
    const canceladaMetafield = (node.metafields?.nodes || []).find(
      mf => mf.key === 'cotizacion_cancelada'
    );
    const remindersCancelledMetafield = (node.metafields?.nodes || []).find(
      mf => mf.key === 'recordatorios_cancelados' && mf.value === 'true'
    );

    let orderStatus = 'Pendiente';
    let statusClass = 'pending';
    if (canceladaMetafield) {
      orderStatus = 'Cancelada';
      statusClass = 'cancelled';
    } else if (ordenCompraMetafield) {
      orderStatus = 'Completada';
      statusClass = 'completed';
    }

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
        sku: li.sku,
        vendor: li.vendor,
        quantity,
        price: formatCurrency(li.variant?.unitPrice?.amount),
        total: formatCurrency(li.variant?.price),
        image: li.image?.url
      };
    });

    const downloadDetails = {
      date: `${date.day}-${date.month}-${date.year} ${date.hours}.${date.minutes}`,
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
      showDate: `${date.day}/${date.month}/${date.year} ${date.hours}:${date.minutes}`,
      internalDate: `${date.year}-${date.month}-${date.day} ${date.hours}:${date.minutes}:${date.seconds}`,
      updatedAt: `${updatedAt.year}-${updatedAt.month}-${updatedAt.day} ${updatedAt.hours}:${updatedAt.minutes}:${updatedAt.seconds}`,
      productsName,
      orderStatus,
      statusClass,
      canceledAt: canceladaMetafield?.value || null,
      remindersActive: !ordenCompraMetafield && !canceladaMetafield && !remindersCancelledMetafield,
      modalProducts,
      itemsSize: node.lineItems?.nodes?.length,
      totalPriceWithoutCurrency: node.totalPriceSet.shopMoney.amount,
      totalPriceWithCurrency: formatCurrency(node.totalPriceSet.shopMoney.amount),
      userName: (node.metafields?.nodes || []).find(mf => mf.key === 'usuario')?.value,
      downloadDetails,
      purchaseOrderUrl: ordenCompraMetafield?.reference?.url || null,
    };
  });
}

async function uploadFileToShopify(buffer, filename, mimeType) {
  const stagedRes = await shopifyRequest(`
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
      }
    }
  `, {
    input: [{
      filename,
      mimeType,
      resource: 'FILE',
      httpMethod: 'POST'
    }]
  });

  const target = stagedRes.stagedUploadsCreate.stagedTargets[0];

  const form = new FormData();
  for (const param of target.parameters) {
    form.append(param.name, param.value);
  }
  form.append('file', buffer, {
    filename,
    contentType: mimeType,
  });

  await axios.post(target.url, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  const fileRes = await shopifyRequest(`
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files { id }
        userErrors { message }
      }
    }
  `, {
    files: [{
      originalSource: target.resourceUrl,
    }]
  });

  if (fileRes.fileCreate.userErrors?.length) {
    throw new Error(fileRes.fileCreate.userErrors[0].message);
  }

  return fileRes.fileCreate.files[0].id;
}

async function attachFileMetafield(orderId, fileId) {
  await shopifyRequest(`
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `, {
    metafields: [{
      ownerId: orderId,
      namespace: 'custom',
      key: 'orden_de_compra',
      type: 'file_reference',
      value: fileId,
    }]
  });
}

function buildPurchaseOrderUploadedEmail({
  orderName,
}) {
  return `
    <!DOCTYPE html>
    <html>
      <body style="margin:0; font-family:Arial, sans-serif; font-size:18px; color:#000;">
        <table width="90%" cellpadding="0" cellspacing="0" style="padding: 20px;">
          <tr>
            <td style="width: 50%; text-align: left; padding: 20px;">
              <img src="https://cdn.shopify.com/s/files/1/0641/0338/3246/files/Logo_Inicio_1080x266_ffd1075f-6821-4fb0-a7ae-19e4c844dcf1.png?v=1731683448" width="250" />
            </td>
            <td style="width: 50%; text-align: right; padding: 20px;">
              <img src="https://cdn.shopify.com/s/files/1/0657/4266/7889/files/logo_752e5e69-8f82-4967-9b77-7d3dccad1230.png?v=1767720071" width="200" />
            </td>
          </tr>
        </table>

        <table width="90%" cellpadding="0" cellspacing="0" style="margin:auto; border-collapse:collapse;">
          <tr>
            <td style="padding:20px; font-size:18px;">
              <p>Hola,</p>
              <p>
                Se ha subido correctamente una Orden de Compra asociada a la cotización <strong>${orderName}</strong>
              </p>
              <p>
                Puedes revisar la información completa desde el panel de cotizaciones.
              </p>
            </td>
          </tr>
        </table>

        <table width="90%" cellpadding="0" cellspacing="0" style="margin:20px auto;">
          <tr>
            <td style="padding: 15px; text-align: right;">
              <a
                href="https://apiweser.generandoideas.com/pages/cotizaciones"
                style="
                  background-color:#FF7300;
                  color:#fff;
                  padding:12px 25px;
                  text-decoration:none;
                  border-radius:5px;
                  font-weight:bold;
                  display:inline-block;
                "
              >
                Ver Cotizaciones
              </a>
            </td>
          </tr>
        </table>

      </body>
    </html>
  `;
}

function buildApartadoCancelEmail({ orderName, audience }) {
  const intro = audience === 'vendor'
    ? `<p>Buen día,</p>
       <p>
         Se informa que el apartado de productos solicitado derivado de la cotización
         <strong>${orderName}</strong> ha sido <strong>cancelado</strong>.
       </p>
       <p>
         Pueden liberar los productos previamente apartados. Agradecemos su atención y apoyo.
       </p>`
    : `<p>Hola,</p>
       <p>
         La cotización <strong>${orderName}</strong> ha sido <strong>cancelada</strong>.
         Se notificó a los proveedores para liberar el apartado y se detuvieron los recordatorios.
       </p>`;

  return `
    <!DOCTYPE html>
    <html>
      <body style="margin:0; font-family:Arial, sans-serif; font-size:18px; color:#000;">
        <table width="90%" cellpadding="0" cellspacing="0" style="padding: 20px;">
          <tr>
            <td style="width: 50%; text-align: left; padding: 20px;">
              <img src="https://cdn.shopify.com/s/files/1/0641/0338/3246/files/Logo_Inicio_1080x266_ffd1075f-6821-4fb0-a7ae-19e4c844dcf1.png?v=1731683448" width="250" />
            </td>
            <td style="width: 50%; text-align: right; padding: 20px;">
              <img src="https://cdn.shopify.com/s/files/1/0657/4266/7889/files/logo_752e5e69-8f82-4967-9b77-7d3dccad1230.png?v=1767720071" width="200" />
            </td>
          </tr>
        </table>

        <table width="90%" cellpadding="0" cellspacing="0" style="margin:auto; border-collapse:collapse;">
          <tr>
            <td style="padding:20px; font-size:18px;">
              ${intro}
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
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
            totalPriceSet {
              shopMoney { amount }
            }
            lineItems(first: 50) {
              nodes {
                title
                variant { displayName selectedOptions { name value } unitPrice { amount } price }
                product { descriptionHtml }
                sku
                vendor
                image { url }
              }
            }
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
            {
                key: 'email_usuario',
                namespace: 'custom',
                type: 'single_line_text_field',
                value: email,
            },
        ],
    };

    const data = await shopifyRequest(mutation, { input });

    const { draftOrderCreate } = data;
    if (draftOrderCreate.userErrors && draftOrderCreate.userErrors.length > 0) {
        throw new HttpsError("invalid-argument", "Shopify validation errors", draftOrderCreate.userErrors);
    }

    const draftOrder = [draftOrderCreate.draftOrder];
    const orders = getOrdersObject(draftOrder);

    let htmlLineItems = '';

    for (const lineItem of orders[0].downloadDetails.line_items) {
      htmlLineItems += `
        <tr>
          <td style="padding:10px; border: .5px solid #000; text-align:left;">
            <img src="${lineItem.image}" width="80" />
          </td>
          <td style="padding:10px; border: .5px solid #000; text-align:left;">
            ${lineItem.title}
          </td>
          <td style="padding:10px; border: .5px solid #000; text-align:left;">
            ${lineItem.description}
          </td>
          <td style="padding:10px; border: .5px solid #000; text-align:center;">
            ${lineItem.quantity}
          </td>
          <td style="padding:10px; border: .5px solid #000; text-align:center;">
            ${lineItem.unit_price}
          </td>
          <td style="padding:10px; border: .5px solid #000; text-align:center;">
            ${lineItem.line_price}
          </td>
        </tr>
      `;
    }

    for (const t of orders[0].downloadDetails.totals) {
        htmlLineItems += `
            <tr>
                <td style="border: none;"></td>
                <td style="border: none;"></td>
                <td style="border: none;"></td>
                <td style="border: none;"></td>
                <td style="text-align: center; border: .5px solid #000000; padding: 0; font-weight: bolder; background-color: #FF7300;">${t.key}</td>
                <td style="text-align: center; border: .5px solid #000000; padding: 0;">${t.value}</td>
            </tr>
        `;
    }

    const htmlEmail = `
    <!DOCTYPE html>
    <html>
        <body style="margin:0; font-family:Arial, sans-serif; font-size:18px; color:#000;">
            <table width="90%" cellpadding="0" cellspacing="0" style="padding: 20px;">
                <tr>
                    <td style="width: 50%; text-align: left; padding: 20px;">
                        <img src="https://cdn.shopify.com/s/files/1/0641/0338/3246/files/Logo_Inicio_1080x266_ffd1075f-6821-4fb0-a7ae-19e4c844dcf1.png?v=1731683448" width="250" />
                    </td>
                    <td style="width: 50%; text-align: right; padding: 20px;">
                        <img src="https://cdn.shopify.com/s/files/1/0657/4266/7889/files/logo_752e5e69-8f82-4967-9b77-7d3dccad1230.png?v=1767720071" width="200" />
                    </td>
                </tr>
            </table>

            <table width="90%" align="center" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                <thead>
                    <tr>
                        <th style="background:#FF7300; border:.5px solid #000; padding: 10px;">IMAGEN</th>
                        <th style="background:#FF7300; border:.5px solid #000; padding: 10px;">NOMBRE</th>
                        <th style="background:#FF7300; border:.5px solid #000; padding: 10px;">DESCRIPCIÓN</th>
                        <th style="background:#FF7300; border:.5px solid #000; padding: 10px;">CANTIDAD</th>
                        <th style="background:#FF7300; border:.5px solid #000; padding: 10px;">PRECIO UNITARIO</th>
                        <th style="background:#FF7300; border:.5px solid #000; padding: 10px;">IMPORTE</th>
                    </tr>
                </thead>
                <tbody>
                    ${htmlLineItems}
                </tbody>
            </table>

            <table width="90%" align="center" cellpadding="0" cellspacing="0" style="margin: 20px auto;">
                <tr>
                    <td style="padding: 15px 0; text-align: left; font-size: 18px; font-weight: bold; color: #000;">
                        Cotización creada por: ${userName}
                    </td>
                    <td style="padding: 15px 0; text-align: right;">
                        <a href="https://apiweser.generandoideas.com/pages/cotizaciones"
                        style="background-color: #FF7300; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">
                            Ver Cotizaciones
                        </a>
                    </td>
                </tr>
            </table>
        </body>
    </html>
    `;

    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'Cotizador Weser Pharma <notificaciones@generandoideas.com>',
      to: [
          'aespinosa@generandoideas.com',
          'zchino@generandoideas.com',
          'dolores.martinez@weserpharma.com.mx',
          // 'alejandra.aguilar@siegfried.com.mx',
      ],
      cc: 'acontreras@generandoideas.com',
      subject: `Cotización ${orders[0].name} creada | Cotizador Weser Pharma`,
      html: htmlEmail,
    });

    const startDate = new Date();
    const formattedsStartDate = formatDate(startDate);
    const uniqueVendors = [...new Set(orders[0].modalProducts.map(item => item.vendor))];
    const vendorEndDates = [];
    const apartadoEmailRefs = [];
    for (const vendor of uniqueVendors) {
        if (['Fabricacion', 'LAMY'].includes(vendor)) continue;
        const endDate = calculateBusinessDays(startDate, vendorsInfo[vendor].days);
        vendorEndDates.push(endDate);
        const formattedEndDate = formatDate(endDate);

        const vendorItems = orders[0].modalProducts.filter(item => item.vendor === vendor);
        let vendorHtmlLineItems = '';
        for (const vendorItem of vendorItems) {
          vendorHtmlLineItems += `
            <tr>
              <td style="padding:10px; border: .5px solid #000; text-align:center;">
                <img src="${vendorItem.image}" width="80" />
              </td>
              <td style="padding:10px; border: .5px solid #000; text-align:center;">
                ${vendorItem.title}
              </td>
              <td style="padding:10px; border: .5px solid #000; text-align:center;">
                ${vendorItem.sku}
              </td>
              <td style="padding:10px; border: .5px solid #000; text-align:center;">
                ${vendorItem.quantity}
              </td>
            </tr>
          `;
        }
        const vendorHtmlEmail = `
        <!DOCTYPE html>
        <html>
            <body style="margin:0; font-family:Arial, sans-serif; font-size:18px; color:#000;">
                <table width="90%" cellpadding="0" cellspacing="0" style="padding: 20px;">
                    <tr>
                        <td style="width: 100%; text-align: center; padding: 20px;">
                            <img src="https://cdn.shopify.com/s/files/1/0641/0338/3246/files/Logo_Inicio_1080x266_ffd1075f-6821-4fb0-a7ae-19e4c844dcf1.png?v=1731683448" width="250" />
                        </td>
                    </tr>
                </table>

                <table width="90%" cellpadding="0" cellspacing="0" style="margin:auto; border-collapse:collapse;">
                  <tr>
                    <td style="padding:20px 0; font-size:18px; font-weight: bold;">
                      <p>Buen día, team ${vendor}.</p>
                      <p>
                        Derivado de una cotización en nuestra API de Weser Pharma, atentamente se pide el apartado por un periodo de ${vendorsInfo[vendor].days} días hábiles de los siguientes productos.
                      </p>
                      <p>
                        El periodo de apartado será desde el ${formattedsStartDate.day}/${formattedsStartDate.month}/${formattedsStartDate.year} hasta el ${formattedEndDate.day}/${formattedEndDate.month}/${formattedEndDate.year}.
                      </p>
                    </td>
                  </tr>
                </table>

                <table width="90%" align="center" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                    <thead>
                        <tr>
                            <th style="background:#FF7300; border:.5px solid #000; padding: 10px;">IMAGEN</th>
                            <th style="background:#FF7300; border:.5px solid #000; padding: 10px;">NOMBRE</th>
                            <th style="background:#FF7300; border:.5px solid #000; padding: 10px;">CLAVE</th>
                            <th style="background:#FF7300; border:.5px solid #000; padding: 10px;">CANTIDAD</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${vendorHtmlLineItems}
                    </tbody>
                </table>
            </body>
        </html>
        `;

        // Message-ID propio para poder enlazar después el correo de cancelación al mismo hilo.
        const vendorSlug = vendor.toLowerCase().replace(/[^a-z0-9]/g, '');
        const messageId = `<apartado-${Date.now()}-${vendorSlug}@generandoideas.com>`;

        await resend.emails.send({
          from: 'Generando Ideas <notificaciones@generandoideas.com>',
          to: vendorsInfo[vendor].recipients,
          cc: [
              'ihernandez@generandoideas.com',
              'aespinosa@generandoideas.com',
              'zchino@generandoideas.com',
              'acontreras@generandoideas.com'
          ],
          subject: 'Apartado de Productos | Generando Ideas',
          html: vendorHtmlEmail,
          headers: { 'Message-ID': messageId },
        });

        apartadoEmailRefs.push({
            vendor,
            messageId,
            recipients: vendorsInfo[vendor].recipients,
        });
    }

    const metafieldsToSet = [];

    if (vendorEndDates.length > 0) {
        const maxEndDate = new Date(Math.max(...vendorEndDates.map(d => d.getTime())));
        const yyyy = maxEndDate.getFullYear();
        const mm = String(maxEndDate.getMonth() + 1).padStart(2, '0');
        const dd = String(maxEndDate.getDate()).padStart(2, '0');
        metafieldsToSet.push({
            ownerId: draftOrderCreate.draftOrder.id,
            namespace: 'custom',
            key: 'vencimiento_apartado',
            type: 'date',
            value: `${yyyy}-${mm}-${dd}`,
        });
    }

    if (apartadoEmailRefs.length > 0) {
        metafieldsToSet.push({
            ownerId: draftOrderCreate.draftOrder.id,
            namespace: 'custom',
            key: 'apartado_email_refs',
            type: 'json',
            value: JSON.stringify(apartadoEmailRefs),
        });
    }

    if (metafieldsToSet.length > 0) {
        await shopifyRequest(`
            mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
                metafieldsSet(metafields: $metafields) {
                    userErrors { field message }
                }
            }
        `, {
            metafields: metafieldsToSet,
        });
    }

    return { success: true, draftOrder };
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

/**
 * Cancel a Draft Order (cotización)
 * Marks the quotation as cancelled (keeps it as history), notifies the vendors in the
 * same email thread as the original "apartado" email, notifies the internal team /
 * creator, and stops reminders for this quotation.
 * Input:
 * - draftOrderId: String (GID, e.g. "gid://shopify/DraftOrder/123")
 */
exports.cancelDraftOrder = onCall(async (request) => {
    const { draftOrderId } = request.data;

    if (!draftOrderId) {
        throw new HttpsError("invalid-argument", "The function must be called with a 'draftOrderId'.");
    }

    const query = `
      query getDraftOrder($id: ID!) {
        draftOrder(id: $id) {
          id
          name
          metafields(first: 20) {
            nodes { key value }
          }
        }
      }
    `;

    const data = await shopifyRequest(query, { id: draftOrderId });
    const draftOrder = data?.draftOrder;

    if (!draftOrder) {
        throw new HttpsError("not-found", "No se encontró la cotización.");
    }

    const mfs = draftOrder.metafields?.nodes || [];

    if (mfs.some(mf => mf.key === 'orden_de_compra')) {
        throw new HttpsError("failed-precondition", "No se puede cancelar una cotización que ya tiene Orden de Compra.");
    }

    if (mfs.some(mf => mf.key === 'cotizacion_cancelada')) {
        return { success: true, alreadyCancelled: true };
    }

    // Marca de estado: fecha de cancelación en CDMX.
    const nowCDMX = formatDate(new Date());
    await shopifyRequest(`
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
                userErrors { field message }
            }
        }
    `, {
        metafields: [{
            ownerId: draftOrder.id,
            namespace: 'custom',
            key: 'cotizacion_cancelada',
            type: 'date',
            value: `${nowCDMX.year}-${nowCDMX.month}-${nowCDMX.day}`,
        }]
    });

    const resend = new Resend(process.env.RESEND_API_KEY);

    // Correo de cancelación a cada proveedor, enlazado al hilo del apartado original.
    const refsMf = mfs.find(mf => mf.key === 'apartado_email_refs');
    let apartadoRefs = [];
    if (refsMf?.value) {
        try { apartadoRefs = JSON.parse(refsMf.value); } catch (e) { apartadoRefs = []; }
    }

    for (const ref of apartadoRefs) {
        if (!ref.recipients?.length || !ref.messageId) continue;
        await resend.emails.send({
            from: 'Generando Ideas <notificaciones@generandoideas.com>',
            to: ref.recipients,
            cc: [
                'ihernandez@generandoideas.com',
                'aespinosa@generandoideas.com',
                'zchino@generandoideas.com',
                'acontreras@generandoideas.com'
            ],
            subject: 'Re: Apartado de Productos | Generando Ideas',
            html: buildApartadoCancelEmail({ orderName: draftOrder.name, audience: 'vendor' }),
            headers: {
                'In-Reply-To': ref.messageId,
                'References': ref.messageId,
            },
        });
    }

    // Correo al equipo interno + usuario creador.
    const adminRecipients = [
        'aespinosa@generandoideas.com',
        'zchino@generandoideas.com',
        'dolores.martinez@weserpharma.com.mx',
        // 'alejandra.aguilar@siegfried.com.mx',
    ];
    const emailUsuario = mfs.find(mf => mf.key === 'email_usuario')?.value;
    const internalTo = emailUsuario ? [...adminRecipients, emailUsuario] : adminRecipients;

    await resend.emails.send({
        from: 'Cotizador Weser Pharma <notificaciones@generandoideas.com>',
        to: internalTo,
        cc: 'acontreras@generandoideas.com',
        subject: `Cotización ${draftOrder.name} cancelada | Cotizador Weser Pharma`,
        html: buildApartadoCancelEmail({ orderName: draftOrder.name, audience: 'internal' }),
    });

    return { success: true };
});

/**
 * Cancel reminders only (the project continues, OC pending, but stop daily reminders).
 * Input:
 * - draftOrderId: String (GID)
 */
exports.cancelReminders = onCall(async (request) => {
    const { draftOrderId } = request.data;

    if (!draftOrderId) {
        throw new HttpsError("invalid-argument", "The function must be called with a 'draftOrderId'.");
    }

    await shopifyRequest(`
        mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
                userErrors { field message }
            }
        }
    `, {
        metafields: [{
            ownerId: draftOrderId,
            namespace: 'custom',
            key: 'recordatorios_cancelados',
            type: 'boolean',
            value: 'true',
        }]
    });

    return { success: true };
});

exports.uploadPurchaseOrder = onRequest(
  { timeoutSeconds: 300, memory: '1GiB' },
  async (req, res) => {
    res.set('Access-Control-Allow-Origin', 'https://apiweser.generandoideas.com');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      return res.status(204).send('');
    }

    if (req.method !== 'POST') {
      return res.status(405).send('Method not allowed');
    }

    const busboy = Busboy({ headers: req.headers });

    let fileBuffer;
    let fileName;
    let mimeType;
    let orderId;
    let orderName;

    busboy.on('file', (_, file, info) => {
      fileName = info.filename;
      mimeType = info.mimeType;

      const buffers = [];
      file.on('data', d => buffers.push(d));
      file.on('end', () => {
        fileBuffer = Buffer.concat(buffers);
      });
    });

    busboy.on('field', (name, value) => {
      if (name === 'orderId') orderId = value;
      if (name === 'orderName') orderName = value;
    });

    busboy.on('finish', async () => {
      try {
        const fileId = await uploadFileToShopify(fileBuffer, fileName, mimeType);

        await attachFileMetafield(orderId, fileId);

        const resend = new Resend(process.env.RESEND_API_KEY);

        const htmlEmail = buildPurchaseOrderUploadedEmail({
          orderName,
        });

        await resend.emails.send({
          from: 'Cotizador Weser Pharma <notificaciones@generandoideas.com>',
          to: [
            'aespinosa@generandoideas.com',
            'zchino@generandoideas.com'
          ],
          cc: 'acontreras@generandoideas.com',
          subject: `Orden de compra subida para cotización ${orderName} | Cotizador Weser Pharma`,
          html: htmlEmail,
        });

        res.json({ success: true });
      } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
      }
    });

    busboy.end(req.rawBody);
  }
);

function buildApartadoReminderEmail(orderRows) {
  let orderSections = '';

  for (const order of orderRows) {
    const [y, m, d] = order.vencimiento.split('-');
    const remainingLabel = order.remainingDays === 0
      ? 'Vence hoy'
      : `${order.remainingDays} día${order.remainingDays !== 1 ? 's' : ''}`;

    let productRows = '';
    for (const p of order.products) {
      const daysLabel = p.vendorDays != null ? `${p.vendorDays} días hábiles` : '-';
      productRows += `
        <tr>
          <td style="padding:8px; border:.5px solid #ccc; text-align:center;">
            ${p.image ? `<img src="${p.image}" width="60" style="display:block;margin:auto;" />` : '-'}
          </td>
          <td style="padding:8px; border:.5px solid #ccc; text-align:left;">${p.title}</td>
          <td style="padding:8px; border:.5px solid #ccc; text-align:center;">${p.sku || '-'}</td>
          <td style="padding:8px; border:.5px solid #ccc; text-align:center;">${p.quantity || '-'}</td>
          <td style="padding:8px; border:.5px solid #ccc; text-align:center;">${daysLabel}</td>
        </tr>
      `;
    }

    orderSections += `
      <table width="90%" cellpadding="0" cellspacing="0" style="margin:0 auto 30px; border-collapse:collapse;">
        <tr>
          <td colspan="6" style="padding:12px 10px; background:#FF7300; color:#fff; font-weight:bold; font-size:18px;">
            ${order.nombre}
            &nbsp;&nbsp;|&nbsp;&nbsp;
            Creada por: ${order.usuario}
            &nbsp;&nbsp;|&nbsp;&nbsp;
            Fecha de creación: ${order.fechaCreacion}
            &nbsp;&nbsp;|&nbsp;&nbsp;
            Vence: ${d}/${m}/${y}
            &nbsp;&nbsp;|&nbsp;&nbsp;
            <span style="background-color:${order.daysBg}; color:${order.daysColor}; padding:2px 8px; border-radius:4px;">
              ${remainingLabel}
            </span>
          </td>
        </tr>
        <tr>
          <th style="background:#ffeedd; border:.5px solid #ccc; padding:8px; color:#000; font-size:14px;">IMAGEN</th>
          <th style="background:#ffeedd; border:.5px solid #ccc; padding:8px; color:#000; font-size:14px;">NOMBRE</th>
          <th style="background:#ffeedd; border:.5px solid #ccc; padding:8px; color:#000; font-size:14px;">CLAVE</th>
          <th style="background:#ffeedd; border:.5px solid #ccc; padding:8px; color:#000; font-size:14px;">CANTIDAD</th>
          <th style="background:#ffeedd; border:.5px solid #ccc; padding:8px; color:#000; font-size:14px;">DÍAS APARTADO</th>
        </tr>
        ${productRows}
      </table>
    `;
  }

  return `
    <!DOCTYPE html>
    <html>
      <body style="margin:0; font-family:Arial, sans-serif; font-size:18px; color:#000;">
        <table width="90%" cellpadding="0" cellspacing="0" style="padding:20px; margin:auto;">
          <tr>
            <td style="width:50%; text-align:left; padding:20px;">
              <img src="https://cdn.shopify.com/s/files/1/0641/0338/3246/files/Logo_Inicio_1080x266_ffd1075f-6821-4fb0-a7ae-19e4c844dcf1.png?v=1731683448" width="250" />
            </td>
            <td style="width:50%; text-align:right; padding:20px;">
              <img src="https://cdn.shopify.com/s/files/1/0657/4266/7889/files/logo_752e5e69-8f82-4967-9b77-7d3dccad1230.png?v=1767720071" width="200" />
            </td>
          </tr>
        </table>

        <table width="90%" cellpadding="0" cellspacing="0" style="margin:0 auto 20px;">
          <tr>
            <td style="padding:0 20px;">
              <p>Buen día,</p>
              <p>A continuación se muestran las cotizaciones con apartados vigentes que aún no tienen Orden de Compra adjunta.</p>
            </td>
          </tr>
        </table>

        ${orderSections}

        <table width="90%" cellpadding="0" cellspacing="0" style="margin:20px auto;">
          <tr>
            <td style="padding:15px 0; text-align:right;">
              <a href="https://apiweser.generandoideas.com/pages/cotizaciones"
                style="background-color:#FF7300; color:#fff; padding:12px 25px; text-decoration:none; border-radius:5px; font-weight:bold; display:inline-block;">
                Ver Cotizaciones
              </a>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
}

async function runRecordatorio() {
    const query = `
        query {
            draftOrders(first: 50, query:"tag:weserpharma", reverse: true) {
                nodes {
                    id
                    name
                    createdAt
                    lineItems(first: 50) {
                        nodes {
                            title
                            sku
                            vendor
                            image { url }
                            variant {
                                selectedOptions { name value }
                            }
                        }
                    }
                    metafields(first: 10) {
                        nodes {
                            key
                            value
                        }
                    }
                }
            }
        }
    `;

    const data = await shopifyRequest(query);
    const nodes = data?.draftOrders?.nodes || [];

    const todayCDMX = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
    todayCDMX.setHours(0, 0, 0, 0);

    const activeOrders = nodes.reduce((acc, node) => {
        const mfs = node.metafields?.nodes || [];
        const hasOrdenCompra = mfs.some(mf => mf.key === 'orden_de_compra');
        const hasCancelada = mfs.some(mf => mf.key === 'cotizacion_cancelada');
        const remindersOff = mfs.some(mf => mf.key === 'recordatorios_cancelados' && mf.value === 'true');
        const vencimientoMf = mfs.find(mf => mf.key === 'vencimiento_apartado');

        if (hasOrdenCompra || hasCancelada || remindersOff || !vencimientoMf) return acc;

        const [year, month, day] = vencimientoMf.value.split('-').map(Number);
        const endDate = new Date(year, month - 1, day);
        const remainingDays = Math.ceil((endDate - todayCDMX) / (1000 * 60 * 60 * 24));

        if (remainingDays < 0) return acc;

        const usuarioMf = mfs.find(mf => mf.key === 'usuario');
        const emailUsuarioMf = mfs.find(mf => mf.key === 'email_usuario');
        const date = formatDate(node.createdAt);

        let daysColor = '#000';
        let daysBg = '#ffffff';
        if (remainingDays === 0) {
            daysColor = '#fff';
            daysBg = '#dc2626';
        } else if (remainingDays <= 2) {
            daysColor = '#fff';
            daysBg = '#FF7300';
        }

        const products = (node.lineItems?.nodes || []).map(li => {
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
                sku: li.sku,
                vendorDays: vendorsInfo[li.vendor]?.days ?? null,
                quantity,
                image: li.image?.url || null,
            };
        });

        acc.push({
            nombre: node.name,
            usuario: usuarioMf?.value || '-',
            emailUsuario: emailUsuarioMf?.value || null,
            fechaCreacion: `${date.day}/${date.month}/${date.year}`,
            vencimiento: vencimientoMf.value,
            remainingDays,
            daysColor,
            daysBg,
            products,
        });

        return acc;
    }, []).sort((a, b) => a.remainingDays - b.remainingDays);

    if (activeOrders.length === 0) {
        logger.info('recordatorioApartado: no hay apartados vigentes hoy.');
        return { sent: false, orders: 0 };
    }

    const adminRecipients = [
        'aespinosa@generandoideas.com',
        'zchino@generandoideas.com',
        'dolores.martinez@weserpharma.com.mx',
        // 'alejandra.aguilar@siegfried.com.mx',
    ];

    const ordersByUserEmail = activeOrders.reduce((acc, order) => {
        const key = order.emailUsuario || '__sin_email__';
        if (!acc[key]) acc[key] = [];
        acc[key].push(order);
        return acc;
    }, {});

    const resend = new Resend(process.env.RESEND_API_KEY);

    for (const [userEmail, userOrders] of Object.entries(ordersByUserEmail)) {
        const to = userEmail === '__sin_email__'
            ? adminRecipients
            : [...adminRecipients, userEmail];

        await resend.emails.send({
            from: 'Cotizador Weser Pharma <notificaciones@generandoideas.com>',
            to,
            cc: 'acontreras@generandoideas.com',
            subject: `Recordatorio: ${userOrders.length} apartado${userOrders.length !== 1 ? 's' : ''} vigente${userOrders.length !== 1 ? 's' : ''} sin OC | Cotizador Weser Pharma`,
            html: buildApartadoReminderEmail(userOrders),
        });
    }

    logger.info(`recordatorioApartado: recordatorio enviado para ${activeOrders.length} cotizaciones.`);
    return { sent: true, orders: activeOrders.length };
}

exports.recordatorioApartado = onSchedule(
    { schedule: '0 9 * * 1-5', timeZone: 'America/Mexico_City' },
    runRecordatorio
);

// TEMPORAL — borrar después de probar
// exports.testRecordatorio = onRequest(async (_req, res) => {
//     const result = await runRecordatorio();
//     res.json(result);
// });
