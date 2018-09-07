FROM node:10-alpine

RUN mkdir -p /usr/src/app && chown -R node /usr/src/app
WORKDIR /usr/src/app
USER node
COPY package.json /usr/src/app
COPY wicked-sdk.tgz /usr/src/app
RUN ls -la
RUN npm install
COPY . /usr/src/app

CMD ["node", "index.js"]
