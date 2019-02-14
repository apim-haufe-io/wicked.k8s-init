'use strict';

const async = require('async');
const fs = require('fs');
const path = require('path');
const request = require('request');
const wicked = require('wicked-sdk');
const https = require('https');
const kubernetesAgent = new https.Agent({ rejectUnauthorized: false });

const TOKEN_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/token';

let APP_ID = 'app-id';
let API_ID = 'api-id';
let PLAN_ID = 'unlimited';
let CLIENT_TYPE = wicked.WickedClientType.Public_SPA;
let SECRET_NAME = 'some-secret';
let NAMESPACE = 'default';

let initSuccess = true;

if (!process.env.KUBERNETES_SERVICE_HOST) {
    console.error('ERROR: KUBERNETES_SERVICE_HOST is not set.');
    initSuccess = false;
}
if (!process.env.KUBERNETES_SERVICE_PORT) {
    console.error('ERROR: KUBERNETES_SERVICE_PORT is not set.');
    initSuccess = false;
}
if (!fs.existsSync(TOKEN_FILE)) {
    console.error('ERROR: File ' + TOKEN_FILE + ' does not exist.');
    initSuccess = false;
}

if (!process.env.REDIRECT_URI) {
    console.error('ERROR: REDIRECT_URI is not set.');
    initSuccess = false;
}
if (!initSuccess) {
    console.error('Not successful, exiting.');
    process.exit(1);
}

if (process.env.NAMESPACE)
    NAMESPACE = process.env.NAMESPACE;
if (process.env.APP_ID)
    APP_ID = process.env.APP_ID;
if (process.env.API_ID)
    API_ID = process.env.API_ID;
if (process.env.PLAN_ID)
    PLAN_ID = process.env.PLAN_ID;
if (process.env.CLIENT_TYPE)
    CLIENT_TYPE = process.env.CLIENT_TYPE;
if (process.env.SECRET_NAME)
    SECRET_NAME = process.env.SECRET_NAME;

const REDIRECT_URI = process.env.REDIRECT_URI;
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8');

console.log('Using k8s Namespace: ' + NAMESPACE);
console.log('Using App ID:        ' + APP_ID);
console.log('Using API ID:        ' + API_ID);
console.log('Using Plan ID:       ' + PLAN_ID);
console.log('Using Client Type:   ' + CLIENT_TYPE);
console.log('Using Secret Name:   ' + SECRET_NAME);
console.log('Using Redirect URI:  ' + REDIRECT_URI);

const KUBERNETES_API = 'https://' + process.env.KUBERNETES_SERVICE_HOST +
    ':' + process.env.KUBERNETES_SERVICE_PORT + '/api/v1/';

const USER_AGENT = 'auto-deploy';

const wickedOptions = {
    userAgentName: USER_AGENT,
    userAgentVersion: getVersion(),
    doNotPollConfigHash: true
};

async.series({
    init: callback => initWicked(wickedOptions, callback),
    initMachine: callback => wicked.initMachineUser(USER_AGENT, callback),
    createApp: callback => createAppIfNotPresent(APP_ID, REDIRECT_URI, CLIENT_TYPE, callback),
    createSubs: callback => createSubscriptionIfNotPresent(APP_ID, API_ID, callback),
}, function (err, results) {
    if (err) {
        console.error('ERROR: Initialization failed.');
        if (err.statusCode)
            console.error('Status code: ' + err.statusCode);
        if (err.body) {
            console.error('Error body:');
            console.error(err.body);
        }
        throw err;
    }

    const subscription = results.createSubs;
    upsertKubernetesSecret(subscription, function (err) {
        if (err) {
            console.error('ERROR: Upserting Kubernetes Secret failed.');
            console.error(err);
            throw err;
        }
        console.log('INFO: Successfully finished.');
    });
});

function initWicked(wickedOptions, callback) {
    console.log('Initializing wicked.');
    wicked.initialize(wickedOptions, callback);
}

function getApplication(appId, callback) {
    console.log('Get applications');
    wicked.getApplication(appId, function (err, appInfo) {
        if (err && err.statusCode === 404)
            return callback(null, null);
        return callback(null, appInfo);
    });
}

function createAppIfNotPresent(appId, redirectUri, clientType, callback) {
    console.log('Create application if not present');
    wicked.getApplication(appId, function (err, appInfo) {
        if (err && err.statusCode === 404) {
            // App not present, fine
            appInfo = null; // This will already be the case.
        } else if (err) {
            return callback(err);
        }
        if (appInfo) {
            console.log('Application is present');
            // Nothing to do
            return callback(null);
        }
        console.log('Creating application');
        wicked.createApplication({
            id: appId,
            name: appId + ' (auto generated)',
            clientType: clientType,
            redirectUri: redirectUri
        }, function (err, appInfo) {
            if (err) {
                console.error('ERROR: Creating application failed');
                return callback(err);
            }
            callback(null);
        });
    });
}

function createSubscriptionIfNotPresent(appId, apiId, callback) {
    console.log('Create subscription if not present');
    wicked.getSubscriptions(appId, function (err, subsList) {
        if (err)
            return callback(err);
        const subs = subsList.find(s => s.api === apiId);
        if (subs) {
            console.log('Subscription is present');
            return callback(null, subs);
        }
        console.log('Creating subscription');
        wicked.createSubscription(appId, {
            application: appId,
            api: apiId,
            plan: PLAN_ID
        }, function (err, newSubs) {
            if (err) {
                console.error('ERROR: Creating subscription failed.');
                console.error(err);
                return callback(err);
            }
            return callback(null, newSubs);
        });
    });
}

function urlCombine(p1, p2) {
    const pp1 = p1.endsWith('/') ? p1.substring(0, p1.length - 1) : p1;
    const pp2 = p2.startsWith('/') ? p2.substring(1) : p2;
    return pp1 + '/' + pp2;
}

function kubernetesAction(endpoint, method, body, callback) {
    const uri = urlCombine(KUBERNETES_API, endpoint);
    console.log("Kubernetes: " + method + " " + uri);
    const req = {
        uri: uri,
        method: method,
        headers: {
            'Authorization': 'Bearer ' + TOKEN,
            'Accept': 'application/json'
        },
        agent: kubernetesAgent
    };
    if (body) {
        req.json = true;
        req.body = body;
    }
    request(req, function (err, apiResult, apiBody) {
        if (err) {
            console.error('ERROR: Call "' + method + '" to "' + endpoint + '" failed.');
            console.error(err);
            return callback(err);
        }
        if (method === 'GET' && apiResult.statusCode === 404) {
            // Special treatment for 404
            return callback(null, null);
        }
        const jsonBody = getJson(apiBody);
        if (apiResult.statusCode >= 400) {
            // Translate status code to error
            const err = new Error(JSON.stringify(jsonBody));
            return callback(err);
        }
        return callback(null, jsonBody);
    });
}

function kubernetesGet(endpoint, callback) {
    kubernetesAction(endpoint, 'GET', null, callback);
}

function kubernetesPost(endpoint, body, callback) {
    kubernetesAction(endpoint, 'POST', body, callback);
}

function kubernetesDelete(endpoint, callback) {
    kubernetesAction(endpoint, 'DELETE', null, callback);
}

function upsertKubernetesSecret(subscription, callback) {
    const secretUrl = 'namespaces/' + NAMESPACE + '/secrets';
    const secretGetUrl = urlCombine(secretUrl, SECRET_NAME);
    async.series([
        callback => deleteKubernetesSecretIfPresent(secretGetUrl, callback),
        callback => createKubernetesSecret(subscription, secretUrl, callback)
    ], callback);
}

function deleteKubernetesSecretIfPresent(getUrl, callback) {
    kubernetesGet(getUrl, function (err, data) {
        if (err)
            return callback(err);
        if (data)
            return kubernetesDelete(getUrl, callback);
        // Not present
        return callback(null);
    });
}

function createKubernetesSecret(subscription, secretUrl, callback) {
    let stringData = {};
    if (subscription.clientId && subscription.clientSecret) {
        stringData.client_id = subscription.clientId;
        stringData.client_secret = subscription.clientSecret;
    } else if (subscription.apikey) {
        stringData.api_key = subscription.apikey;
    } else {
        // wtf?
        const errorMessage = 'Subscription does not contain neither client_id and client_secret nor apikey';
        console.error(errorMessage + ':');
        console.error(JSON.stringify(subscription));
        return callback(new Error(errorMessage));
    }
    kubernetesPost(secretUrl, {
        metadata: { name: SECRET_NAME },
        stringData: stringData
    }, callback);
}

function getJson(ob) {
    if (ob instanceof String || typeof ob === "string") {
        ob = ob.trim();
        if (ob.startsWith('[') || (ob.startsWith('[')))
            return JSON.parse(ob);
        return { message: ob };
    }
    return ob;
}

function getVersion() {
    const packageFile = path.join(__dirname, 'package.json');
    if (fs.existsSync(packageFile)) {
        try {
            const packageInfo = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
            if (packageInfo.version)
                return packageInfo.version;
        } catch (ex) {
            console.error(ex);
        }
    }
    console.error("WARNING: Could not retrieve package version, returning 0.0.0.");
    return "0.0.0";
}
