(function() {
    
    var smart = require('../client/entry');
    var oauth2 = require('../client/bb-client');
    var client = require('../client/client');
    
    angular.module('ng-smart', ['ng', 'ng-fhir']);

    angular.module('ng-smart').provider('$smart', function() {
        var prov;
        return prov = {
            $get: function($http, $q, $fhir) {
                var adapter = {http: $http, defer: $q.defer, fhirjs: $fhir};

                // Set the adapter
                smart(adapter);
                
                // Return the smart object.  this will be used to initilize the client with the correct adapter
                return {client: client, oauth2: oauth2}
            }
        };
    });

}).call(this);
