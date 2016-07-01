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

        process.on('SIGTERM', () => {
            clearTimeout(this.consul_session_renew_timeout);
            clearTimeout(this.renew_find);
            this.consul_session_release();
        });
    }

    consul_service_find() {
        const url = util.format('%s/v1/agent/services', this.consul_server);
        Unirest.get(url)
            .headers({ 'Accept': 'application/json', 'Content-Type': 'application/json' })
            .end((response) => {

                if (!response.ok) {
                    console.log('i cant connect to consul...');
                    return setTimeout(() => {
                        this.consul_get_register_data();
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

        this.consul_find_kv();
    }

    registerTcpCheck() {
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
                    if (response.ok) {
                        console.log('register tcp check ok: ' + item.Service);
                    } else {
                        console.log('register tcp check fail: ' + item.Service);
                    }
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

                // el agent consul no responde
                if (!response.ok) {
                    // consul do not responds and i have the lock, restart and wait for consul up
                    if (this.ID !== null) {
                        console.log('upsss, problems');
                        process.exit(0);
                    }
                    this.consul_session_create();
                    return;
                }

                this.consul_kv_find_process(response.body, response.headers);
            });
    }

    consul_kv_find_process(body, headers) {
        this.find_index = headers['x-consul-index'];

        // i dont have the lock
        if (this.ID === null) {
            //nobody has the lock
            if (body[0].Session === undefined) {
                this.consul_session_create();
            }
            //
            else {
                console.log('somelse has the lock, wait for release ..');
            }
        }
        // i have the lock
        else {
            // consul confirm it
            if (body[0].Session === this.ID) {
                console.log('i have the lock, check again in 10s');
            }
            // consul say another service has the lock
            else {
                console.log('ups, i lost the lock, stop');
                process.exit(0);
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
            console.log('lock acquired');
            this.ID = ID;
            this.emit('consul_leader');
            this.registerTcpCheck();
            this.consul_session_renew();
        } else {
            console.log('lock NOT acquired');
            this.emit('consul_not_leader');
            this.consul_kv_find(false);
        }
    }

    consul_session_renew() {
        const url = util.format('%s/v1/session/renew/%s', this.consul_server, this.ID);

        Unirest.put(url)
            .headers({ 'Accept': 'application/json', 'Content-Type': 'application/json' })
            .end((response) => {

                if (!response.ok) {
                    console.log('fail send data to consul');
                // this never happend
                //} else if (response.body[0].ID !== this.ID) {
                //    console.log('session fail, stop server');
                } else {
                    console.log('i have the lock, renew session ttl');
                    this.emit('consul_session_renew');
                }

                this.consul_session_renew_timeout = setTimeout(() => {
                    this.consul_session_renew();
                }, 5000);
            });
    }

    // consul_session_renew_process(){}

    consul_session_release() {
        if (this.ID === null)
            return this.emit('close');

        const url = util.format('%s/v1/session/destroy/%s', this.consul_server, this.ID);
        Unirest.put(url)
            .end((response) => {
                if (response.ok)
                    console.log('release session ok');
                else
                    console.log('release session fail');

                return this.emit('consul_close');
            });

    }

}

module.exports = ConsulServiceLeader;
