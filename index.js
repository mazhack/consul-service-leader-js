"use strict";

const Unirest = require('unirest');
const util = require('util');

const EventEmitter = require('events');

class ConsulServiceLeader extends EventEmitter {

    constructor(group_name, service_name, service_register) {
        super();

        this.group_name = group_name;
        this.service_name = service_name;
        this.service_register = service_register;

        this.consul_server = process.env.CONSUL_URL || 'http://localhost:8500';
        this.ID = null;

        this.find_index = 0;
        this.consul_kv_find_timeout = 0;
        this.consul_session_renew_timeout = 0;

        this.services = [];
    }

    get(url) {
        let req = Unirest.get(url).headers({ 'Accept': 'application/json', 'Content-Type': 'application/json' });
        req.exec = function () {
            return new Promise((resolve, reject) => {
                this.end((response) => {
                    if (response.ok)
                        resolve(response);
                    else
                        reject(response.status);
                });
            });
        }
        return req;
    }

    consul_start() {
        this.consul_service_find()
            .then((services) => {
                if (services) {
                    this.consul_kv_find();
                }
            });
    }

    consul_service_find() {
        const url = util.format('%s/v1/agent/services', this.consul_server);
        return this.get(url).exec()
            .then((response) => {
                const services = [];

                Object.keys(response.body).forEach((key) => {
                    services.push(response.body[key]);
                });

                services.forEach((item) => {
                    const r = this.service_register.find((name) => {
                        return name === item.Service;
                    });
                    if (r) {
                        this.services.push(item);
                    }
                });

                if (this.services.length === 0)
                    throw new Error('no services');

                return this.services;
            }).catch((error) => {
                this.emit('services_not_found');
                setTimeout(() => {
                    this.consul_service_find();
                }, 2000);
                //return 1;
            });
    }

    is_leader() {
        return this.ID !== null;
    }

    is_not_leader() {
        return this.ID === null;
    }

    consul_response_fail(response) {
        if (!response.ok) {
            this.emit('consul_agent_offline');
            return true;
        }
        return false;
    }

    /*
        consul_service_find() {
            const url = util.format('%s/v1/agent/services', this.consul_server);
            Unirest.get(url)
                .headers({ 'Accept': 'application/json', 'Content-Type': 'application/json' })
                .end((response) => {

                    if (this.consul_response_fail(response)) {
                        return setTimeout(() => {
                            this.consul_service_find();
                        }, 2000);
                    }

                    this.consul_service_find_process(response.body);
                });
        }

        consul_service_find_process(data) {
            const services = [];

            Object.keys(data).forEach((key) => {
                services.push(data[key]);
            });

            services.forEach((item) => {
                const r = this.service_register.find((name) => {
                    return name === item.Service;
                });
                if (r) {
                    this.services.push(item);
                }
            });

            this.consul_kv_find();
        }
    */
    consul_check_create() {
        const url = util.format('%s/v1/agent/check/register', this.consul_server);
        this.services.forEach((item) => {
            Unirest.put(url)
                .headers({ 'Accept': 'application/json', 'Content-Type': 'application/json' })
                .send({
                    Name: 'service:' + item.ID,
                    TCP: item.Address + ':' + item.Port,
                    Interval: '5s',
                    ServiceID: item.ID
                })
                .end((response) => {
                    this.emit('consul_check_register', response.ok === true);
                });
        });
    }

    consul_kv_find(wait = true) {
        let url;
        if (wait) {
            url = util.format('%s/v1/kv/%s/%s?index=%s&wait=10s', this.consul_server, this.group_name, this.service_name, this.find_index);
        } else {
            url = util.format('%s/v1/kv/%s/%s', this.consul_server, this.group_name, this.service_name);
        }

        clearTimeout(this.consul_kv_find_timeout);

        Unirest.get(url)
            .headers({ 'Accept': 'application/json', 'Content-Type': 'application/json' })
            .end((response) => {

                this.consul_kv_find_timeout = setTimeout(() => {
                    this.consul_kv_find();
                }, 2000);

                // no existe la clave
                if (response.notFound)
                    return this.consul_session_create();

                // el agent consul no responde
                if (this.consul_response_fail(response)) {
                    return;
                }
                this.consul_kv_find_process(response.body, response.headers);
            });
    }

    consul_kv_find_process(body, headers) {
        this.find_index = headers['x-consul-index'];

        // i dont have the lock
        if (this.is_not_leader()) {
            //nobody has the lock
            if (body[0].Session === undefined) {
                this.consul_session_create();
            }
            //
            else {
                this.emit('consul_leader_exists');
            }
        }
        // i have the lock
        else {
            // consul confirm it
            if (body[0].Session === this.ID) {
                this.emit('consul_leader_check');
            }
            // consul say another service has the lock
            else {
                this.emit('consul_leader_lost');
            }

        }
    }

    consul_session_create() {

        const url = util.format('%s/v1/session/create', this.consul_server);

        Unirest.put(url)
            .headers({ 'Accept': 'application/json', 'Content-Type': 'application/json' })
            .send({
                LockDelay: '1s',
                TTL: '10s',
                Behavior: 'release',

                Name: this.group_name + '_' + this.service_name
            })
            .end((response) => {
                if (!response.ok) {
                    return;
                }
                if (!response.body.ID) {
                    return;
                }
                //this.consul_session_create_process(response.body.ID);
                this.consul_kv_adquire(response.body.ID);
            });
    }

    // consul_session_create_process(body){}

    consul_kv_adquire(ID) {

        const url = util.format('%s/v1/kv/%s/%s?acquire=%s', this.consul_server, this.group_name, this.service_name, ID);

        Unirest.put(url)
            .headers({ 'Accept': 'application/json', 'Content-Type': 'application/json' })
            .send({
                Group: this.group_name,
                Name: this.service_name,
            })
            .end((response) => {
                if (!response.ok) {
                    return;
                }
                this.consul_kv_adquire_process(ID, response.raw_body.toString().trim() === 'true');
            });
    }

    /**
     * @param Boolean adquire
     */
    consul_kv_adquire_process(ID, is_adquire) {
        if (is_adquire) {
            this.ID = ID;
            this.emit('consul_lock_adquire');
            this.consul_check_create();
            this.consul_session_renew();
        } else {
            this.emit('consul_lock_not_adquire');
            this.consul_kv_find(false);
        }
    }

    consul_session_renew() {
        const url = util.format('%s/v1/session/renew/%s', this.consul_server, this.ID);

        Unirest.put(url)
            .headers({ 'Accept': 'application/json', 'Content-Type': 'application/json' })
            .end((response) => {

                this.consul_session_renew_timeout = setTimeout(() => {
                    this.consul_session_renew();
                }, 5000);

                if (this.consul_response_fail(response)) {
                    return;
                } else {
                    this.emit('consul_session_renew');
                }
            });
    }

    // consul_session_renew_process(){}

    consul_session_release() {

        clearTimeout(this.consul_session_renew_timeout);
        clearTimeout(this.consul_kv_find_timeout);

        if (this.ID === null)
            return this.emit('consul_leader_release', true);

        const url = util.format('%s/v1/session/destroy/%s', this.consul_server, this.ID);
        Unirest.put(url)
            .end((response) => {
                this.emit('consul_leader_release', response.ok === true);
            });

    }

}

module.exports = ConsulServiceLeader;
