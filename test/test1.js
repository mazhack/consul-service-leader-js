"use strict";

var chai = require('chai');
var expect = chai.expect;

const Leader = require('../');

Leader.get = function (url) {
    return {
        exec: function () {
            return Promise.resolve(require('data'));
        }
    }
};

describe("test1.js", function () {

    it('service no exists', function (done) {

        let leader = new Leader('taxidispatch', 'service', ['td.mqtt.taxixxx']);

        leader.on('services_not_found', function () {
            done();
        });
        leader.consul_service_find();

    });

    it('find service', function (done) {

        let leader = new Leader('taxidispatch', 'service', ['td.mqtt.taxi']);
        leader.consul_service_find().then((services) => {
            expect(services).to.be.instanceOf(Array);
            expect(services.length).to.be.equal(1);
            expect(services[0]).to.eql({
                ID: '03c6b4d26b82:td_taximqtt_dev:8090',
                Service: 'td.mqtt.taxi',
                Tags: ['td mqtt'],
                Address: '192.168.100.2',
                Port: 8090,
                EnableTagOverride: false,
                CreateIndex: 0,
                ModifyIndex: 0
            });

            done();
        });

    });

});
