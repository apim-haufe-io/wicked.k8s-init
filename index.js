'use strict';

/* global __dirname */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const wicked = require('wicked-sdk');
const https = require('https');
const kubernetesAgent = new https.Agent({ rejectUnauthorized: false });

function getDate() { return new Date().toISOString(); }
function info(s) { console.log(`[${getDate()}] INFO - ${s}`); }
function warn(s) { console.log(`[${getDate()}] WARN - ${s}`); }
function error(s) { console.error(`[${getDate()}] ERROR - ${s}`); }

const TOKEN_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/token';

let APP_ID = 'app-id';
let API_ID = 'api-id';
let PLAN_ID = 'unlimited';
let CLIENT_TYPE = wicked.WickedClientType.Public_SPA;
let SECRET_NAME = 'some-secret';
let NAMESPACE = 'default';

let initSuccess = true;

let TOKEN;
if (!process.env.IGNORE_K8S) {
    if (!process.env.KUBERNETES_SERVICE_HOST) {
        error('KUBERNETES_SERVICE_HOST is not set.');
        initSuccess = false;
    }
    if (!process.env.KUBERNETES_SERVICE_PORT) {
        error('KUBERNETES_SERVICE_PORT is not set.');
        initSuccess = false;
    }
    if (!fs.existsSync(TOKEN_FILE)) {
        error('File ' + TOKEN_FILE + ' does not exist.');
        initSuccess = false;
    } else {
        TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8');
    }
}
if (!process.env.REDIRECT_URI) {
    error('REDIRECT_URI is not set.');
    initSuccess = false;
}
if (!initSuccess) {
    error('Not successful, exiting.');
    process.exit(1);
}

if (process.env.NAMESPACE) {
    NAMESPACE = process.env.NAMESPACE;
}
if (process.env.APP_ID) {
    APP_ID = process.env.APP_ID;
}
if (process.env.API_ID) {
    API_ID = process.env.API_ID;
}
if (process.env.PLAN_ID) {
    PLAN_ID = process.env.PLAN_ID;
}
if (process.env.CLIENT_TYPE) {
    CLIENT_TYPE = process.env.CLIENT_TYPE;
}
if (process.env.SECRET_NAME) {
    SECRET_NAME = process.env.SECRET_NAME;
}

const REDIRECT_URIS = process.env.REDIRECT_URI.split('|');

info('Using k8s Namespace: ' + NAMESPACE);
info('Using App ID:        ' + APP_ID);
info('Using API ID:        ' + API_ID);
info('Using Plan ID:       ' + PLAN_ID);
info('Using Client Type:   ' + CLIENT_TYPE);
info('Using Secret Name:   ' + SECRET_NAME);
info('Using Redirect URIs:  ' + REDIRECT_URIS);

const KUBERNETES_API = 'https://' + process.env.KUBERNETES_SERVICE_HOST +
    ':' + process.env.KUBERNETES_SERVICE_PORT + '/api/v1/';

const USER_AGENT = 'auto-deploy';

const wickedOptions = {
    userAgentName: USER_AGENT,
    userAgentVersion: getVersion(),
    doNotPollConfigHash: true
};

(async () => {
    try {
        await initWicked(wickedOptions);
        await wicked.initMachineUser(USER_AGENT);
        await createAppIfNotPresent(APP_ID, REDIRECT_URIS, CLIENT_TYPE);
        const subscription = await createSubscriptionIfNotPresent(APP_ID, API_ID);
        if (!process.env.IGNORE_K8S) {
            await upsertKubernetesSecret(subscription);
        } else {
            warn('Detected env var IGNORE_K8S - not upserting Kubernetes secret.');
        }
        info('Successfully created or checked application/subscription.');
        process.exit(0);
    } catch (err) {
        error('Initialization failed.');
        if (err.statusCode) {
            error('Status code: ' + err.statusCode);
        }
        if (err.body) {
            error('Error body:');
            error(JSON.stringify(err.body));
        }
        process.exit(1);
    }
})();

async function initWicked(wickedOptions) {
    info('Initializing wicked.');
    await wicked.initialize(wickedOptions);
}

async function createAppIfNotPresent(appId, redirectUris, clientType) {
    info('Create application if not present');
    let appInfo = null;
    try {
        appInfo = await wicked.getApplication(appId);
    } catch (err) {
        if (err.statusCode !== 404) {
            throw err;
        }
        // App not present, fine; we have status 404
    }
    if (appInfo) {
        info('Application is already present.');
        // Check whether name and redirect URIs match
        const presentUris = appInfo.redirectUris.join('|');
        const newUris = redirectUris.join('|');
        if (presentUris !== newUris
            || appInfo.clientType !== clientType) {
            info('** Application has changed, patching...');
            await wicked.patchApplication(appId, {
                id: appId,
                clientType,
                redirectUris
            });
        } else {
            info('Application does not need patch.');
        }
    } else {
        info('Creating application...');
        await wicked.createApplication({
            id: appId,
            name: appId + ' (auto generated)',
            clientType: clientType,
            redirectUris: redirectUris
        });
    }
}

async function createSubscriptionIfNotPresent(appId, apiId) {
    info('Creating subscription if not present...');
    const subsList = await wicked.getSubscriptions(appId);
    const subs = subsList.find(s => s.api === apiId);
    if (subs) {
        info('Subscription is present.');
        if (subs.plan !== PLAN_ID) {
            info('** Plan ID has changed, deleting...');
            await wicked.deleteSubscription(appId, apiId);
        } else {
            info('Subscription is correct, not changing.');
            return subs;
        }
    }
    info('Creating subscription...');
    return await wicked.createSubscription(appId, {
        application: appId,
        api: apiId,
        plan: PLAN_ID
    });
}

function urlCombine(p1, p2) {
    const pp1 = p1.endsWith('/') ? p1.substring(0, p1.length - 1) : p1;
    const pp2 = p2.startsWith('/') ? p2.substring(1) : p2;
    return pp1 + '/' + pp2;
}

async function kubernetesAction(endpoint, method, body) {
    const uri = urlCombine(KUBERNETES_API, endpoint);
    info("Kubernetes: " + method + " " + uri);
    const req = {
        uri: uri,
        method: method,
        headers: {
            'Authorization': 'Bearer ' + TOKEN,
            'Accept': 'application/json'
        },
        httpsAgent: kubernetesAgent
    };
    if (body) {
        req.data = body;
    }

    try {
        const res = await axios(req);
        return res.data;
    } catch (err) {
        if (method === 'GET' && err.response && err.response.status === 404) {
            // Special treatment for 404
            return null;
        }
        throw err;
    }
}

async function kubernetesGet(endpoint) {
    return await kubernetesAction(endpoint, 'GET', null);
}

async function kubernetesPost(endpoint, body) {
    return await kubernetesAction(endpoint, 'POST', body);
}

async function kubernetesDelete(endpoint) {
    return await kubernetesAction(endpoint, 'DELETE', null);
}

async function upsertKubernetesSecret(subscription) {
    const secretUrl = 'namespaces/' + NAMESPACE + '/secrets';
    const secretGetUrl = urlCombine(secretUrl, SECRET_NAME);
    await deleteKubernetesSecretIfPresent(secretGetUrl);
    await createKubernetesSecret(subscription, secretUrl);
    return;
}

async function deleteKubernetesSecretIfPresent(getUrl) {
    const secret = await kubernetesGet(getUrl);
    if (secret) {
        return await kubernetesDelete(getUrl);
    }
}

async function createKubernetesSecret(subscription, secretUrl) {
    let stringData = {};
    if (subscription.clientId && subscription.clientSecret) {
        stringData.client_id = subscription.clientId;
        stringData.client_secret = subscription.clientSecret;
    } else if (subscription.apikey) {
        stringData.api_key = subscription.apikey;
    } else {
        // wtf?
        const errorMessage = 'Subscription does not contain neither client_id and client_secret nor apikey';
        error(errorMessage + ':');
        error(JSON.stringify(subscription));
        throw new Error(errorMessage);
    }
    return await kubernetesPost(secretUrl, {
        metadata: { name: SECRET_NAME },
        stringData: stringData
    });
}

function getVersion() {
    const packageFile = path.join(__dirname, 'package.json');
    if (fs.existsSync(packageFile)) {
        try {
            const packageInfo = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
            if (packageInfo.version) {
                return packageInfo.version;
            }
        } catch (ex) {
            error(ex);
        }
    }
    warn("Could not retrieve package version, returning 0.0.0.");
    return "0.0.0";
}
