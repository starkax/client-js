var Adapter = require('./adapter');
var FhirClient = require('./client');
var Guid = require('./guid');
var jwt = require('jsonwebtoken');

var BBClient = module.exports =  {debug: true}


function urlParam(p, forceArray) {
  
  if (forceArray === undefined) {
    forceArray = false;
  }

  var query = window.location.search.substr(1);
  var data = query.split("&");
  var result = [];

  for(var i=0; i<data.length; i++) {
    var item = data[i].split("=");
    if (item[0] === p) {
      var res = item[1].replace(/\+/g, '%20');
      result.push(decodeURIComponent(res));
    }
  }

  if (forceArray) {
    return result;
  }
  if (result.length === 0){
    return null;
  }
  return result[0];
}

function stripTrailingSlash(str) {
    if(str.substr(-1) === '/') {
        return str.substr(0, str.length - 1);
    }
    return str;
}

function getPreviousToken(){
  var ret = window.sessionStorage.tokenResponse;
  if (ret) ret = JSON.parse(ret);
  return ret;
}

function completeTokenFlow(hash){

  if (!hash){
    hash = window.location.hash;
  }
  var ret = Adapter.get().defer();

  process.nextTick(function(){
    var oauthResult = hash.match(/#(.*)/);
    oauthResult = oauthResult ? oauthResult[1] : "";
    oauthResult = oauthResult.split(/&/);
    var authorization = {};
    for (var i = 0; i < oauthResult.length; i++){
      var kv = oauthResult[i].split(/=/);
      if (kv[0].length > 0 && kv[1]) {
        authorization[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1]);
      }
    }
    ret.resolve(authorization);
  });

  return ret.promise;
}

function completeCodeFlow(params){
  
  if (!params){
    params = {
      code: urlParam('code'),
      state: urlParam('state')
    };
  }
  
  var ret = Adapter.get().defer();
  var state = JSON.parse(window.sessionStorage[params.state]);

  if (window.history.replaceState && BBClient.settings.replaceBrowserHistory){
    window.history.replaceState({}, "", window.location.toString().replace(window.location.search, ""));
  }

  var data = {
      code: params.code,
      grant_type: 'authorization_code',
      redirect_uri: state.client.redirect_uri
  };

  var headers = { 'Content-Type': 'application/x-www-form-urlencoded'};

  if (state.client.secret) {
    headers['Authorization'] = 'Basic ' + btoa(state.client.client_id + ':' + state.client.secret);
  } else {
    data['client_id'] = state.client.client_id;
  }

  Adapter.get().http({
    method: 'POST',
    url: state.provider.oauth2.token_uri,
    data: $.param(data),
    headers: headers
  }).then(function(response){
       var authz = response.data;
       for (var i in params) {
          if (params.hasOwnProperty(i)) {
             authz[i] = params[i];
          }
       }
       ret.resolve(authz);
  }, function(){
    console.log("failed to exchange code for access_token", arguments);
    ret.reject();
  });

  return ret.promise;
}

function completePageReload(){
  var d = Adapter.get().defer();
  process.nextTick(function(){
    d.resolve(getPreviousToken());
  });
  return d.promise;
}

function readyArgs(){
  var input = null;
  var callback = function(){};
  var errback = function(){};

  if (arguments.length === 0){
    throw "Can't call 'ready' without arguments";
  } else if (arguments.length === 1){
    callback = arguments[0];
  } else if (arguments.length === 2){
    if (typeof arguments[0] === 'function'){
      callback = arguments[0];
      errback = arguments[1];
    } else if (typeof arguments[0] === 'object'){
      input = arguments[0];
      callback = arguments[1];
    } else {
      throw "ready called with invalid arguments";
    }
  } else if (arguments.length === 3){
    input = arguments[0];
    callback = arguments[1];
    errback = arguments[2];
  } else {
    throw "ready called with invalid arguments";
  }

  return {
    input: input,
    callback: callback,
    errback: errback
  };
}

// Client settings
BBClient.settings = {
    replaceBrowserHistory: true
};

BBClient.ready = function(input, callback, errback){
  var args = readyArgs.apply(this, arguments);

  // decide between token flow (implicit grant) and code flow (authorization code grant)
  var isCode = urlParam('code') || (args.input && args.input.code);

  var accessTokenResolver = null;
  if (window.sessionStorage.tokenResponse) { // we're reloading after successful completion
    accessTokenResolver = completePageReload();
  } else if (isCode) { // code flow
    accessTokenResolver = completeCodeFlow(args.input);
  } else { // token flow
    accessTokenResolver = completeTokenFlow(args.input);
  }
  accessTokenResolver.then(function(tokenResponse){

    if (!tokenResponse || !tokenResponse.state) {
      return args.errback("No 'state' parameter found in authorization response.");
    }
    
    window.sessionStorage.tokenResponse = JSON.stringify(tokenResponse);

    var state = JSON.parse(window.sessionStorage[tokenResponse.state]);
    if (state.fake_token_response) {
      tokenResponse = state.fake_token_response;
    }

    var fhirClientParams = {
      serviceUrl: state.provider.url,
      patientId: tokenResponse.patient
    };
    
    if (tokenResponse.id_token) {
        var id_token = tokenResponse.id_token;
        var payload = jwt.decode(id_token);
        fhirClientParams["userId"] = payload["profile"]; 
    }

    if (tokenResponse.access_token !== undefined) {
      fhirClientParams.auth = {
        type: 'bearer',
        token: tokenResponse.access_token
      };
    } else if (!state.fake_token_response){
      return args.errback("Failed to obtain access token.");
    }

    var ret = FhirClient(fhirClientParams);
    ret.state = JSON.parse(JSON.stringify(state));
    ret.tokenResponse = JSON.parse(JSON.stringify(tokenResponse));
    args.callback(ret);

  }).catch(function(){
    args.errback("Failed to obtain access token.");
  });

};

function providers(fhirServiceUrl, provider, callback, errback){

  // Shim for pre-OAuth2 launch parameters
  if (isBypassOAuth()){
    process.nextTick(function(){
      bypassOAuth(fhirServiceUrl, callback);
    });
    return;
  }

  // Skip conformance statement introspection when overriding provider setting are available
  if (provider) {
    provider['url'] = fhirServiceUrl;
    process.nextTick(function(){
      callback && callback(provider);
    });
    return;
  }

  Adapter.get().http({
    method: "GET",
    url: stripTrailingSlash(fhirServiceUrl) + "/metadata"
  }).then(
    function(response){
      var r = response.data;
      var res = {
        "name": "SMART on FHIR Testing Server",
        "description": "Dev server for SMART on FHIR",
        "url": fhirServiceUrl,
        "oauth2": {
          "registration_uri": null,
          "authorize_uri": null,
          "token_uri": null
        }
      };

      try {
        var smartExtension = r.rest[0].security.extension.filter(function (e) {
           return (e.url === "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris");
        });

        smartExtension[0].extension.forEach(function(arg, index, array){
          if (arg.url === "register") {
            res.oauth2.registration_uri = arg.valueUri;
          } else if (arg.url === "authorize") {
            res.oauth2.authorize_uri = arg.valueUri;
          } else if (arg.url === "token") {
            res.oauth2.token_uri = arg.valueUri;
          }
        });
      }
      catch (err) {
        return errback && errback(err);
      }

      callback && callback(res);
    }, function() {
        errback && errback("Unable to fetch conformance statement");
    }
  );
};

var noAuthFhirProvider = function(serviceUrl){
  return {
    "oauth2": null,
    "url": serviceUrl
  }
};

function relative(url){
  return (window.location.protocol + "//" + window.location.host + window.location.pathname).match(/(.*\/)[^\/]*/)[1] + url;
}

function isBypassOAuth(){
  return (urlParam("fhirServiceUrl") && !(urlParam("iss")));
}

function bypassOAuth(fhirServiceUrl, callback){
  callback && callback({
    "oauth2": null,
    "url": fhirServiceUrl || urlParam("fhirServiceUrl")
  });
}

BBClient.authorize = function(params, errback){
  

  if (!errback){
    errback = function(){
        console.log("Failed to discover authorization URL given", params);
    };
  }
  
  // prevent inheritance of tokenResponse from parent window
  delete window.sessionStorage.tokenResponse;

  if (!params.client){
    params = {
      client: params
    };
  }

  if (!params.response_type){
    params.response_type = 'code';
  }

   if (!params.client.redirect_uri){
    params.client.redirect_uri = relative("");
  }

  if (!params.client.redirect_uri.match(/:\/\//)){
    params.client.redirect_uri = relative(params.client.redirect_uri);
  }

  var launch = urlParam("launch");
  if (launch){
    if (!params.client.scope.match(/launch/)){
      params.client.scope += " scope";
    }
    params.client.launch = launch;
  }

  var server = urlParam("iss") || urlParam("fhirServiceUrl");
  if (server){
    if (!params.server){
      params.server = server;
    }
  }

  if (urlParam("patientId")){
    params.fake_token_response = params.fake_token_response || {};
    params.fake_token_response.patient = urlParam("patientId");
  }

  providers(params.server, params.provider, function(provider){

    params.provider = provider;

    var state = params.client.state || Guid.newGuid();
    var client = params.client;

    if (params.provider.oauth2 == null) {
      window.sessionStorage[state] = JSON.stringify(params);
      window.sessionStorage.tokenResponse = JSON.stringify({state: state});
      window.location.href = client.redirect_uri + "#state="+encodeURIComponent(state);
      return;
    }

    window.sessionStorage[state] = JSON.stringify(params);

    console.log("sending client reg", params.client);

    var redirect_to=params.provider.oauth2.authorize_uri + "?" + 
      "client_id="+encodeURIComponent(client.client_id)+"&"+
      "response_type="+encodeURIComponent(params.response_type)+"&"+
      "scope="+encodeURIComponent(client.scope)+"&"+
      "redirect_uri="+encodeURIComponent(client.redirect_uri)+"&"+
      "state="+encodeURIComponent(state)+"&"+
      "aud="+encodeURIComponent(params.server);
    
    if (typeof client.launch !== 'undefined' && client.launch) {
       redirect_to += "&launch="+encodeURIComponent(client.launch);
    }

    window.location.href = redirect_to;
  }, errback);
};

BBClient.resolveAuthType = function (fhirServiceUrl, callback, errback) {

      Adapter.get().http({
         method: "GET",
         url: stripTrailingSlash(fhirServiceUrl) + "/metadata"
      }).then(function(r){
          var type = "none";
          
          try {
            if (r.rest[0].security.service[0].coding[0].code.toLowerCase() === "smart-on-fhir") {
                type = "oauth2";
            }
          }
          catch (err) {
          }

          callback && callback(type);
        }, function() {
           errback && errback("Unable to fetch conformance statement");
      });
};
