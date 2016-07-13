"use strict";

var chai = require('chai');
var expect = chai.expect;

const Leader = require('../');

describe("test2.js", function () {

    it('consul not exists 1', function (done) {

        let leader = new Leader('taxidispatch', 'service', ['td.mqtt.taxixxx']);
        leader.consul_server='http://127.0.0.1:33000';

        leader.on('services_not_found', function () {
            done();
        });
        leader.consul_service_find();

    });

    it('consul not exists 2', function (done) {

        let leader = new Leader('taxidispatch', 'service', ['td.mqtt.taxi']);
        leader.consul_server='http://127.0.0.1:33000';
        leader.consul_service_find();
        leader.on('services_not_found', function () {
            done();
        });

    });

});
