# ResolveRetrievalRequest


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**query** | **str** |  |
**profile** | **str** |  | [optional] [default to 'default']
**limits** | [**ResolveRetrievalRequestLimits**](ResolveRetrievalRequestLimits.md) |  | [optional]

## Example

```python
from openapi_client.models.resolve_retrieval_request import ResolveRetrievalRequest

# TODO update the JSON string below
json = "{}"
# create an instance of ResolveRetrievalRequest from a JSON string
resolve_retrieval_request_instance = ResolveRetrievalRequest.from_json(json)
# print the JSON string representation of the object
print(ResolveRetrievalRequest.to_json())

# convert the object into a dict
resolve_retrieval_request_dict = resolve_retrieval_request_instance.to_dict()
# create an instance of ResolveRetrievalRequest from a dict
resolve_retrieval_request_from_dict = ResolveRetrievalRequest.from_dict(resolve_retrieval_request_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
