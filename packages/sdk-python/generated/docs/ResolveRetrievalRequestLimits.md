# ResolveRetrievalRequestLimits


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**max_candidates** | **int** |  | [optional]
**max_graph_depth** | **int** |  | [optional]
**max_resolved_skills** | **int** |  | [optional]
**max_body_bytes** | **int** |  | [optional]
**canonical_threshold** | **float** |  | [optional]
**supporting_threshold** | **float** |  | [optional]

## Example

```python
from openapi_client.models.resolve_retrieval_request_limits import ResolveRetrievalRequestLimits

# TODO update the JSON string below
json = "{}"
# create an instance of ResolveRetrievalRequestLimits from a JSON string
resolve_retrieval_request_limits_instance = ResolveRetrievalRequestLimits.from_json(json)
# print the JSON string representation of the object
print(ResolveRetrievalRequestLimits.to_json())

# convert the object into a dict
resolve_retrieval_request_limits_dict = resolve_retrieval_request_limits_instance.to_dict()
# create an instance of ResolveRetrievalRequestLimits from a dict
resolve_retrieval_request_limits_from_dict = ResolveRetrievalRequestLimits.from_dict(resolve_retrieval_request_limits_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
